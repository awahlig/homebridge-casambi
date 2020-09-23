import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LuminaireAccessory } from './luminaire';
import { CasambiAPI, CasambiNetworkSession } from './casambi';

// delay after login fails before it is retried
const SESSION_RETRY_DELAY = 30000;

// delay after connection is closed before an attempt to re-connect is made
const CONNECTION_RETRY_DELAY = 5000;

/**
 * CasambiPlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class CasambiPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public casambi: CasambiAPI;
  public sessions: CasambiNetworkSession[];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.casambi = new CasambiAPI(config.apiKey);
    this.sessions = [];

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
    if (!config.apiKey) {
      this.log.error('Please configure your Casambi Cloud API key.');
      return;
    }
    if (!config.email || !config.password) {
      this.log.error('Please configure your Casambi credentials.');
      return;
    }

    const sessions: CasambiNetworkSession[] = [];
    try {
      switch (config.loginMode) {

        case 'user': {
          // attempt to log in to the user account
          this.log.info('Logging in to Casambi user account');
          const userSession = await this.casambi.createUserSession(config.email, config.password);
          this.log.info('Successfully logged in to Casambi user account');
          for (const site of userSession.createSites()) {
            const siteSessions = site.createNetworkSessions();
            this.log.info('Found', siteSessions.length, 'network(s) in the site', site.siteInfo.name);
            sessions.push(...siteSessions);
          }
          break;
        }

        case 'network':
        case undefined: {
          // attempt to log in to the network
          this.log.info('Logging in to Casambi network');
          const session = await this.casambi.createNetworkSession(config.email, config.password);
          this.log.info('Successfully logged in to Casambi network', session.networkInfo.name);
          sessions.push(session);
          break;
        }

        default: {
          // bad loginMode
          this.log.error('Unknown login mode:', config.loginMode);
          return;
        }
      }

    } catch (error) {
      if (error.response && error.response.status === 401) {
        // wrong email/password -- stop now
        this.log.error('Error logging in: wrong credentials');

      } else {
        // any other error -- try again later
        this.log.error('Error logging in:', error.message);
        setTimeout(() => {
          this.discoverDevices(config);
        }, SESSION_RETRY_DELAY);
      }

      return;
    }
    
    this.casambi.connection.on('open', this.onConnectionOpen.bind(this));
    this.casambi.connection.on('close', this.onConnectionClose.bind(this));
    this.casambi.connection.on('timeout', this.onConnectionTimeout.bind(this));

    this.sessions = sessions;
    const usedUUIDs = new Set();
    for (const session of sessions) {
      session.on('networkUpdated', this.onNetworkUpdated.bind(this));

      // request a list of all units in the network
      const unitList = await session.requestUnitList();
      this.log.info('Found', Object.keys(unitList).length, 'unit(s) in the network', session.networkInfo.name);

      // loop over the discovered devices and register each one if it has not already been registered
      for (const unitKey in unitList) {
        const unitInfo = unitList[unitKey];
        this.log.info('Unit', unitInfo.name, 'is a', unitInfo.type, 'with fixtureId', unitInfo.fixtureId);
        this.log.debug('Unit info for', unitInfo.name, unitInfo);

        // check if unit type is supported and figure out the handler class for it
        let handlerClass;
        switch (unitInfo.type) {
          case 'Driver': // an LED Driver, e.g. "TCI - PROFESSIONALE CASAMBI"
          case 'Luminaire': {
            handlerClass = LuminaireAccessory;
            break;
          }
          default: {
            this.log.info('Skipping unit', unitInfo.name, '- unsupported type', unitInfo.type);
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
          this.log.info('Restoring accessory', unitInfo.name);

          // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
          // existingAccessory.context.device = device;
          // this.api.updatePlatformAccessories([existingAccessory]);

          // create the accessory handler for the restored accessory
          new handlerClass(this, existingAccessory, session, unitInfo);

        } else {
        // the accessory does not yet exist, so we need to create it
          this.log.info('Registering accessory', unitInfo.name);

          // create a new accessory
          const accessory = new this.api.platformAccessory(unitInfo.name, uuid);

          // request and store fixture info in the `accessory.context`
          // the `context` property can be used to store any data about the accessory you may need
          accessory.context.fixtureInfo = await this.casambi.requestFixtureInformation(unitInfo.fixtureId);

          // create the accessory handler for the newly created accessory
          new handlerClass(this, accessory, session, unitInfo);

          // link the accessory to your platform
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    }

    // remove restored platform accessories that have been unpaired from the network
    // (or are no longer supported by this version of the plugin)
    for (const accessory of this.accessories) {
      if (!usedUUIDs.has(accessory.UUID)) {
        this.log.info('Unregistering accessory', accessory.displayName);

        // unlink the accessory from the platform
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // connect now after the accessories have set up their event listeners for the connection
    this.connect();
  }

  connect() {
    this.log.debug('Connecting and opening wires');
    for (const session of this.sessions) {
      session.openWire()
        .then(() => {
          this.log.debug('Wire opened for network', session.networkInfo.name);
        });
    }
  }

  onConnectionOpen() {
    this.log.info('Connection successful');
  }

  onConnectionClose(code, reason) {
    this.log.error('Connection lost ->', code, reason);
    // connection to server closed -- re-connect after a delay
    setTimeout(this.connect.bind(this), CONNECTION_RETRY_DELAY);
  }

  onConnectionTimeout() {
    // just log it, re-connect is done in the 'close' handler
    this.log.error('Connection timed out');
  }

  onNetworkUpdated(message) {
    this.log.info('Network updated', message);
    // TODO -- discover new devices, remove old ones
  }
}
