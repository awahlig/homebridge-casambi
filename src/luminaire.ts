import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';

import { CasambiPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class LuminaireAccessory {
  private service: Service;
  unitId: number;
  lastControlUnit: number;
  minCCT: number;
  maxCCT: number;

  constructor(
    private readonly platform: CasambiPlatform,
    private readonly accessory: PlatformAccessory,
    unitState,
  ) {
    this.unitId = unitState.id;
    this.lastControlUnit = 0;
    this.minCCT = 2700;
    this.maxCCT = 4000;
    
    const fixtureInfo = accessory.context.fixtureInfo;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, fixtureInfo.vendor)
      .setCharacteristic(this.platform.Characteristic.Model, fixtureInfo.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, unitState.address);

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    // when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    // this.accessory.getService('NAME') ?? this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE');

    // set the service name, this is what is displayed as the default name on the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, unitState.name);

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
          this.platform.log.warn(`unsupported control type "${controlInfo.type}" for unit "${unitState.name}"`);
          break;
        }
      }
    }

    // Update characteristics to current values and start watching for changes.
    this.updateCharacteristicsFromUnitState(unitState);
    this.platform.connection!.on('message', this.onMessage.bind(this));
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  setOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.platform.log.debug('Set Characteristic On ->', value);

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
  onMessage(message) {
    // filter out notifications for this accessory and update the state in HomeKit
    if (message.method === 'unitChanged' && message.id === this.unitId) {
      this.platform.log.debug('Received unitChanged event');
      this.updateCharacteristicsFromUnitState(message);
    }
  }

  sendControlUnit(targetControls, callback?) {
    const prm = this.platform.connection!.sendControlUnit(this.unitId, targetControls)
      .then(result => {
        this.lastControlUnit = Date.now();
        return result;
      });
    if (callback) {
      return prm.then(result => {
        callback(result);
      }).catch(error => {
        callback(error);
      });
    }
    return prm;
  }

  updateCharacteristicsFromUnitState(unitState) {
    // controls is not set when there's no network gateway
    if (!unitState.controls || !unitState.online) {
      return;
    }
    // suppress characteristic updates resulting from sendControlUnit() call
    if (Date.now() - this.lastControlUnit < 1000) {
      this.lastControlUnit = 0; // ignore only the first update
      return;
    }
    for (const controlInfo of unitState.controls) {
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
}
