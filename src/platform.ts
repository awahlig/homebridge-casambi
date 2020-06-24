import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LuminaireAccessory } from './luminaire';
import { CasambiAPI, CasambiNetworkSession, CasambiConnection } from './casambi';

const RECONNECT_DELAY = 5000;

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
    try {
      this.session = await this.casambi.createNetworkSession(config.network.email, config.network.password);
    } catch (error) {
      if (error.response.status === 401) {
        this.log.error('Error logging into the network. Wrong email/password.');
      } else {
        this.log.error('Error creating network session:', error.message);
      }
      return;
    }
    this.connection = this.session.createConnection();
    this.connection.on('open', this.onConnectionOpen.bind(this));
    this.connection.on('close', this.onConnectionClose.bind(this));
    this.connection.on('networkUpdated', this.onNetworkUpdated.bind(this));

    // request a list of all units in the network
    const unitList = await this.session.requestUnitList();
    this.log.info('Found', Object.keys(unitList).length, 'units in the network');

    // loop over the discovered devices and register each one if it has not already been registered
    const usedUUIDs = new Set();
    for (const unitKey in unitList) {
      const unitInfo = unitList[unitKey];

      // check if unit type is supported and figure out the handler class for it
      let handlerClass;
      switch (unitInfo.type) {
        case 'Luminaire': {
          handlerClass = LuminaireAccessory;
          break;
        }
        default: {
          this.log.warn('Unsupported type', unitInfo.type, 'for unit', unitInfo.name);
          handlerClass = null;
        }
      }
      if (!handlerClass) {
        // move on to the next unit if this one is not supported
        continue;
      }

      // generate a unique id for the accessory; this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      const uuid = this.api.hap.uuid.generate(unitInfo.address);
      usedUUIDs.add(uuid);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
      // the accessory already exists
        this.log.info('Restoring accessory:', unitInfo.name);

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
        // existingAccessory.context.device = device;
        // this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        new handlerClass(this, existingAccessory, unitInfo);

      } else {
      // the accessory does not yet exist, so we need to create it
        this.log.info('Registering accessory:', unitInfo.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(unitInfo.name, uuid);

        // request and store fixture info in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.fixtureInfo = await this.casambi.requestFixtureInformation(unitInfo.fixtureId);

        // create the accessory handler for the newly create accessory
        new handlerClass(this, accessory, unitInfo);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // remove restored platform accessories that have been unpaired from the network
    // (or are no longer supported by this version of the plugin)
    for (const accessory of this.accessories) {
      if (!usedUUIDs.has(accessory.UUID)) {
        this.log.info('Unregistering accessory:', accessory.displayName);

        // unlink the accessory from the platform
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // connect now after the accessories have set up their event listeners for the connection
    this.connect();
  }

  connect() {
    this.log.info('Connecting to Casambi Cloud');
    this.connection!.connect();
  }

  onConnectionOpen() {
    this.log.info('Connection successful');
  }

  onConnectionClose(code, reason) {
    this.log.error('Connection to Casambi Cloud lost ->', code, reason);
    // connection to server closed -- re-connect after a delay
    setTimeout(this.connect.bind(this), RECONNECT_DELAY);
  }

  onNetworkUpdated(message) {
    this.log.info('Network updated ->', message);
    // TODO -- discover new devices, remove old ones
  }
}
