import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback } from 'homebridge';
import { CasambiNetworkSession } from './casambi';

import { CasambiPlatform } from './platform';

// When sliding the brightness bar in the Home App, multiple unit state updates are received
// from the cloud. To avoid interfering with what the user is doing, the updates are passed
// to HomeKit only after a delay. If more updates are received within that time, previous
// updates are dropped and the delay is extended.
const UNITCHANGED_DELAY = 500;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class LuminaireAccessory {
  private service: Service;
  unitName: string;
  unitId: number;
  brightness: number;
  minCCT: number;
  maxCCT: number;
  unitChangedTimeout?: NodeJS.Timeout;

  constructor(
    private readonly platform: CasambiPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly session: CasambiNetworkSession,
    unitInfo,
  ) {
    this.unitName = unitInfo.name;
    this.unitId = unitInfo.id;
    this.minCCT = 2700;
    this.maxCCT = 4000;
    
    const fixtureInfo = accessory.context.fixtureInfo;
    this.platform.log.debug('Fixture info for unit', unitInfo.name, fixtureInfo);

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
    let hasOnCharacteristic = false;
    for (const controlInfo of fixtureInfo.controls) {
      switch (controlInfo.type) {

        case 'dimmer': {
          // register handlers for the On/Off Characteristic
          this.service.getCharacteristic(this.platform.Characteristic.On)
            .on('set', this.setOn.bind(this));
          hasOnCharacteristic = true;

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
          this.platform.log.info('Unsupported control type', controlInfo.type, 'for unit', unitInfo.name);
          break;
        }
      }
    }

    if (!hasOnCharacteristic) {
      this.platform.log.error('Luminaire', unitInfo.name, 'has no On characteristic');
    }

    // get the last known brightness
    this.brightness = this.service.getCharacteristic(this.platform.Characteristic.Brightness).value as number;

    // monitor for state changes; current values are always sent after connecting
    session.on('unitChanged', this.onUnitChanged.bind(this));
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  setOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.platform.log.debug('Set characteristic On of unit', this.unitName, 'to', value);

    this.sendControlUnit(callback, {
      Dimmer: {
        value: (value ? this.brightness : 0) / 100.0,
      },
    });
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  setBrightness(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.platform.log.debug('Set characteristic Brightness of unit', this.unitName, 'to', value);

    this.brightness = value as number;
    this.sendControlUnit(callback, {
      Dimmer: {
        value: this.brightness / 100.0,
      },
    });
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Color Temperature
   */
  setColorTemperature(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.platform.log.debug('Set characteristic ColorTemperature of unit', this.unitName, 'to', value);

    this.sendControlUnit(callback, {
      ColorTemperature: {
        value: Math.min(Math.max(1e6 / (value as number), this.minCCT), this.maxCCT),
      },
      Colorsource: {
        source: 'TW',
      },
    });
  }

  /**
   * Handle notifications from Casambi Cloud.
   */
  onUnitChanged(message) {
    // filter out notifications for this accessory
    if (message.id === this.unitId) {
      this.platform.log.debug('Received unitChanged for', this.unitName, message);

      // update characteristics after a delay
      if (this.unitChangedTimeout) {
        clearTimeout(this.unitChangedTimeout);
      }
      this.unitChangedTimeout = setTimeout(() => {
        this.updateCharacteristicsFromUnitChanged(message);
        this.unitChangedTimeout = undefined;
      }, UNITCHANGED_DELAY);
    }
  }

  updateCharacteristicsFromUnitChanged(message) {
    this.platform.log.debug('Updating characteristics from unitChanged for', this.unitName);

    for (const controlInfo of message.controls) {
      switch (controlInfo.type) {

        case 'Dimmer': {
          const brightness = controlInfo.value * 100.0;
          this.service.updateCharacteristic(this.platform.Characteristic.On, brightness > 0);
          if (brightness > 0) {
            this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
            this.brightness = brightness;
          }
          break;
        }

        case 'CCT': {
          // update CCT limits, used when sending color temperature
          this.minCCT = controlInfo.min;
          this.maxCCT = controlInfo.max;
          const mired = 1e6 / controlInfo.value;
          this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, mired);
          break;
        }

        default: {
          this.platform.log.info('Unsupported control type', controlInfo.type, 'for unit', this.unitName);
          break;
        }
      }
    }
  }

  sendControlUnit(callback: CharacteristicSetCallback, targetControls) {
    this.platform.log.debug('Send controlUnit for', this.unitName, targetControls);
    
    this.session.sendControlUnit(this.unitId, targetControls)
      .then(() => callback(null))
      .catch(err => callback(err));
  }
}
