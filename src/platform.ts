import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LuminaireAccessory } from './luminaire';
import { CasambiAPI, CasambiNetworkSession, CasambiConnection } from './casambi';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class CasambiPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public casambi: CasambiAPI;
  public session?: CasambiNetworkSession;
  public connection?: CasambiConnection;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.casambi = new CasambiAPI(config.apiKey);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices(config);
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * Discover and register accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices(config: PlatformConfig) {
    this.session = await this.casambi.createNetworkSession(config.network.email, config.network.password);
    this.connection = this.session.createConnection();

    // request the state of the entire network
    const networkState = await this.session.requestState();

    // loop over the discovered devices and register each one if it has not already been registered
    for (const unitKey in networkState.units) {
      const unitState = networkState.units[unitKey];
      switch (unitState.type) {
        
        case 'Luminaire': {
          // generate a unique id for the accessory; this should be generated from
          // something globally unique, but constant, for example, the device serial
          // number or MAC address
          const uuid = this.api.hap.uuid.generate(unitState.address);

          // see if an accessory with the same uuid has already been registered and restored from
          // the cached devices we stored in the `configureAccessory` method above
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

          if (existingAccessory) {
            // the accessory already exists
            this.log.info(`restoring accessory: ${unitState.name}`);

            // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
            // existingAccessory.context.device = device;
            // this.api.updatePlatformAccessories([existingAccessory]);

            // create the accessory handler for the restored accessory
            // this is imported from `platformAccessory.ts`
            new LuminaireAccessory(this, existingAccessory, unitState);

          } else {
            // the accessory does not yet exist, so we need to create it
            this.log.info(`registering accessory: ${unitState.name}`);

            // create a new accessory
            const accessory = new this.api.platformAccessory(unitState.name, uuid);

            // request and store fixture info in the `accessory.context`
            // the `context` property can be used to store any data about the accessory you may need
            accessory.context.fixtureInfo = await this.casambi.requestFixtureInformation(unitState.fixtureId);

            // create the accessory handler for the newly create accessory
            // this is imported from `platformAccessory.ts`
            new LuminaireAccessory(this, accessory, unitState);

            // link the accessory to your platform
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }

          // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
          // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          break;
        }

        default: {
          this.log.warn(`unsupported type "${unitState.type}" for unit "${unitState.name}"`);
          break;
        }
      }
    }
  }
}
