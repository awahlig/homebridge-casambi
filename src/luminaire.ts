import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback } from 'homebridge';

import { CasambiPlatform } from './platform';

// how long to suppress characteristic updates after sending controlUnit messages
const CONTROLUNIT_TIMEOUT = 3000;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class LuminaireAccessory {
  private service: Service;
  unitId: number;
  minCCT: number;
  maxCCT: number;
  controlUnitTimeout?: NodeJS.Timeout;

  constructor(
    private readonly platform: CasambiPlatform,
    private readonly accessory: PlatformAccessory,
    unitInfo,
  ) {
    this.unitId = unitInfo.id;
    this.minCCT = 2700;
    this.maxCCT = 4000;
    
    const fixtureInfo = accessory.context.fixtureInfo;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, fixtureInfo.vendor)
      .setCharacteristic(this.platform.Characteristic.Model, fixtureInfo.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, unitInfo.address);

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    // when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    // this.accessory.getService('NAME') ?? this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE');

    // set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, unitInfo.name);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb
    for (const controlInfo of fixtureInfo.controls) {
      switch (controlInfo.type) {

        case 'dimmer': {
          // register handlers for the On/Off Characteristic
          this.service.getCharacteristic(this.platform.Characteristic.On)
            .on('set', this.setOn.bind(this));

          // register handlers for the Brightness Characteristic
          this.service.getCharacteristic(this.platform.Characteristic.Brightness)
            .on('set', this.setBrightness.bind(this));

          break;
        }

        case 'temperature': {
          // register handlers for the ColorTemperature Characteristic
          this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
            .on('set', this.setColorTemperature.bind(this));
          break;
        }

        default: {
          this.platform.log.info('Unsupported control type', controlInfo.type, 'for unit:', unitInfo.name);
          break;
        }
      }
    }

    // monitor for state changes; current values are always sent after connecting
    this.platform.connection!.on('unitChanged', this.onUnitChanged.bind(this));
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  setOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.platform.log.debug('Set Characteristic On ->', value);

    if (value && this.controlUnitTimeout) {
      // HomeKit sometimes sends On=true right after Brightness=x in which case this could overwrite
      // the new brightness with the old one, so skip it.
      this.platform.log.info('Skipping "Turn On" due to recent change');
      callback(null);
      return;
    }

    let brightness = 0;
    if (value) {
      brightness = this.service.getCharacteristic(this.platform.Characteristic.Brightness).value as number;
    }

    this.sendControlUnit({
      Dimmer: {
        value: brightness / 100.0,
      },
    }, callback);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  setBrightness(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.platform.log.debug('Set Characteristic Brightness -> ', value);

    this.sendControlUnit({
      Dimmer: {
        value: value as number / 100.0,
      },
    }, callback);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Color Temperature
   */
  setColorTemperature(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.platform.log.debug('Set Characteristic ColorTemperature -> ', value);

    this.sendControlUnit({
      ColorTemperature: {
        value: Math.min(Math.max(1e6 / (value as number), this.minCCT), this.maxCCT),
      },
      Colorsource: {
        source: 'TW',
      },
    }, callback);
  }

  /**
   * Handle notifications from Casambi Cloud.
   */
  onUnitChanged(message) {
    // filter out notifications for this accessory
    if (message.id === this.unitId) {
      this.platform.log.debug('Received unitChanged event ->', message);

      // suppress characteristic updates right after sendControlUnit() has been called
      if (this.controlUnitTimeout) {
        this.platform.log.debug('Ignoring unitChanged after sending controlUnit');
        clearTimeout(this.controlUnitTimeout);
        this.controlUnitTimeout = undefined;

      } else {
        // update the state of HomeKit
        this.updateCharacteristicsFromUnitChanged(message);
      }
    }
  }

  updateCharacteristicsFromUnitChanged(message) {
    for (const controlInfo of message.controls) {
      switch (controlInfo.type) {

        case 'Dimmer': {
          const brightness = controlInfo.value * 100.0;
          this.service.updateCharacteristic(this.platform.Characteristic.On, brightness > 0);
          if (brightness > 0) {
            this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
          }
          break;
        }

        case 'CCT': {
          // update CCT limits, used when sending color temperature
          this.minCCT = controlInfo.min;
          this.maxCCT = controlInfo.max;
          const mired = 1000000 / controlInfo.value;
          this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, mired);
          break;
        }

        default: {
          break;
        }
      }
    }
  }

  sendControlUnit(targetControls, callback) {
    this.platform.log.debug('Send controlUnit', targetControls);
    this.platform.connection!.sendControlUnit(this.unitId, targetControls, callback);

    if (this.controlUnitTimeout) {
      clearTimeout(this.controlUnitTimeout);
    }
    this.controlUnitTimeout = setTimeout(() => {
      this.platform.log.info('Sent controlUnit but didn\'t receive unitChanged; either nothing changed or gateway is not responding.');
      this.controlUnitTimeout = undefined;
    }, CONTROLUNIT_TIMEOUT);
  }
}
