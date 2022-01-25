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
  private verticalService?: Service;
  unitName: string;
  unitId: number;
  controlType: string;
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
    this.controlType = '';
    this.minCCT = 2700;
    this.maxCCT = 4000;
    this.brightness = 0.0;

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
    for (const controlInfo of fixtureInfo.controls) {
      switch (controlInfo.type.toLowerCase()) {

        case 'dimmer':
        case 'onoff': {
          // register handlers for the On/Off Characteristic
          this.service.getCharacteristic(this.platform.Characteristic.On)
            .on('set', this.setOn.bind(this));
          this.controlType = controlInfo.type.toLowerCase();

          // stop here if this luminaire only has a simple on/off switch
          if (this.controlType === 'onoff') {
            // older versions of the plugin didn't support the 'onoff' control type and could've
            // added the brightness characteristic so remove it here if that's the case
            if (this.service.testCharacteristic(this.platform.Characteristic.Brightness)) {
              const brightness = this.service.getCharacteristic(this.platform.Characteristic.Brightness);
              this.service.removeCharacteristic(brightness);
            }
            break;
          }

          // register handlers for the Brightness Characteristic
          this.brightness = this.service.getCharacteristic(this.platform.Characteristic.Brightness)
            .on('set', this.setBrightness.bind(this))
            .value as number;
          break;
        }

        case 'temperature': {
          // register handlers for the ColorTemperature Characteristic
          this.service.getCharacteristic(this.platform.Characteristic.ColorTemperature)
            .on('set', this.setColorTemperature.bind(this));
          break;
        }

        case 'vertical': {
          // this controls the direction of the light (up/down)

          // if disabled in config, make sure the separate Lightbulb service is removed
          if (this.platform.config.verticalControl !== 'separate') {
            this.platform.log.info('Control type vertical is disabled in config for unit', unitInfo.name);
            const verticalService = this.accessory.getServiceById(this.platform.Service.Lightbulb, 'vertical');
            if (verticalService) {
              this.accessory.removeService(verticalService);
            }
            break;
          }

          // Since there is no corresponding characteristic for this in HomeKit yet, add a separate Lightbulb service
          // and use its Brightness characteristic to control the direction.
          this.verticalService = this.accessory.getServiceById(this.platform.Service.Lightbulb, 'vertical')
            || this.accessory.addService(new this.platform.Service.Lightbulb('', 'vertical'));

          // set the service name, this is what is displayed as the default name on the Home app
          this.service.setCharacteristic(this.platform.Characteristic.Name, unitInfo.name + ' Brightness');
          this.verticalService.setCharacteristic(this.platform.Characteristic.Name, unitInfo.name + ' Up Down');

          // register handlers for the On/Off Characteristic
          this.verticalService.getCharacteristic(this.platform.Characteristic.On)
            .on('set', this.setOn.bind(this));

          // register handlers for the Brightness Characteristic
          this.verticalService.getCharacteristic(this.platform.Characteristic.Brightness)
            .on('set', this.setVerticalBrightness.bind(this));
          break;
        }

        default: {
          this.platform.log.info('Unsupported control type', controlInfo.type, 'for unit', unitInfo.name);
          break;
        }
      }
    }

    // log an error if this luminaire's control type is not supported
    if (!this.controlType) {
      this.platform.log.error('Luminaire', unitInfo.name, 'has an unknown control type');
    }

    // monitor for state changes; current values are always sent after connecting
    session.on('unitChanged', this.onUnitChanged.bind(this));
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  setOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.platform.log.debug('Set characteristic On of unit', this.unitName, 'to', value);

    switch (this.controlType) {
      case 'dimmer': {
        this.sendControlUnit(callback, {
          Dimmer: {
            value: (value ? this.brightness || 100 : 0) / 100.0,
          },
        });
        break;
      }

      case 'onoff': {
        this.sendControlUnit(callback, {
          OnOff: {
            value: value ? 1 : 0,
          },
        });
        break;
      }
    }
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
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  setVerticalBrightness(value: CharacteristicValue, callback: CharacteristicSetCallback) {

    this.platform.log.debug('Set characteristic vertical/Brightness of unit', this.unitName, 'to', value);

    this.sendControlUnit(callback, {
      Vertical: {
        value: 1.0 - (value as number) / 100.0,
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
      switch (controlInfo.type.toLowerCase()) {

        case 'dimmer': {
          const brightness = controlInfo.value * 100.0;
          this.service.updateCharacteristic(this.platform.Characteristic.On, brightness > 0);
          if (brightness > 0) {
            this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
            this.brightness = brightness;
          }
          break;
        }

        case 'onoff': {
          this.service.updateCharacteristic(this.platform.Characteristic.On, controlInfo.value > 0);
          break;
        }

        case 'vertical': {
          if (this.verticalService) {
            const isOn = this.service.getCharacteristic(this.platform.Characteristic.On).value as boolean;
            // mimic the on/off state of the main Lightbulb service
            this.verticalService.updateCharacteristic(this.platform.Characteristic.On, isOn);
            if (isOn) {
              const position = (1.0 - controlInfo.value) * 100.0;
              this.verticalService.updateCharacteristic(this.platform.Characteristic.Brightness, position);
            }
          }
          break;
        }

        case 'cct': {
          // update CCT limits, used when sending color temperature
          this.minCCT = controlInfo.min;
          this.maxCCT = controlInfo.max;
          const mired = 1e6 / controlInfo.value;
          this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, mired);
          break;
        }

        default: {
          this.platform.log.debug('Unsupported control type', controlInfo.type, 'for unit', this.unitName);
          break;
        }
      }
    }
  }

  sendControlUnit(callback: CharacteristicSetCallback, targetControls) {
    this.platform.log.debug('Send controlUnit for', this.unitName, targetControls);

    // Fix for https://github.com/awahlig/homebridge-casambi/issues/23
    let called = false;
    const onceCallback = (result) => {
      if (!called) {
        called = true;
        callback(result);
      }
    };

    this.session.sendControlUnit(this.unitId, targetControls)
      .then(() => onceCallback(null))
      .catch(err => onceCallback(err));
  }
}
