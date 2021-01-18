import events from 'events';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { default as WebSocket } from 'ws';

const MAX_WIRE_ID = 99;
const PING_INTERVAL = 30000;
const PONG_TIMEOUT = PING_INTERVAL + 2000;

/**
 * Main object used to talk to the Casambi Cloud API.
 */
export class CasambiAPI {
  axios: AxiosInstance;

  /**
   * Represents the WebSocket connection to the Casambi Cloud API.
   * https://developer.casambi.com/#ws-service
   */
  connection: CasambiConnection;

  /**
   * You'll need an API key to use this class. See:
   * https://developer.casambi.com/#api-get-started
   * @param apiKey 
   */
  constructor(public apiKey: string) {
    this.axios = axios.create({
      baseURL: 'https://door.casambi.com/v1',
      headers: {'X-Casambi-Key': apiKey},
    });
    this.connection = new CasambiConnection(apiKey);
  }

  get(path: string, config?: AxiosRequestConfig): Promise<any> {
    return this.axios.get(path, config)
      .then((response: AxiosResponse) => response.data);
  }

  post(path: string, data, config?: AxiosRequestConfig): Promise<any> {
    return this.axios.post(path, data, config)
      .then((response: AxiosResponse) => response.data);
  }

  /**
   * Log into given Casambi Network and return a session object.
   * https://developer.casambi.com/#create-network-session
   * @param email 
   * @param password 
   */
  createNetworkSession(email: string, password: string): Promise<CasambiNetworkSession> {
    return this.post('/networks/session', {
      email: email,
      password: password,
    }).then(response => {
      const networkInfo = response[Object.keys(response)[0]];
      return new CasambiNetworkSession(this, networkInfo, networkInfo.sessionId);
    });
  }

  /**
   * Log into given user/site account and return a session object.
   * https://developer.casambi.com/#create-user-session
   * @param email 
   * @param password 
   */
  createUserSession(email: string, password: string): Promise<CasambiUserSession> {
    return this.post('/users/session', {
      email: email,
      password: password,
    }).then(response =>
      new CasambiUserSession(this, response.sites, response.networks, response.sessionId));
  }

  /**
   * https://developer.casambi.com/#request-fixture-information
   * @param fixtureId 
   */
  requestFixtureInformation(fixtureId: number): Promise<any> {
    return this.get(`/fixtures/${fixtureId}`);
  }

  /**
   * https://developer.casambi.com/#request-fixture-icon
   * @param fixtureId 
   */
  requestFixtureIcon(fixtureId: number): Promise<ArrayBuffer> {
    return this.get(`/fixtures/${fixtureId}/icon`, {
      responseType: 'arraybuffer',
    });
  }
}

/**
 * Represents a session for a specific Casambi Network.
 * Create using CasambiAPI.createNetworkSession().
 * 
 * Events:
 * - "wireOpen"
 *   Wire has been opened.
 * - "wireClose"
 *   Wire has been closed.
 * - "unitChanged", peerChanged", "networkUpdated"
 *   Received a network/unit event.
 *   https://developer.casambi.com/#ws-method-types
 * - "wireStatus"
 *   Received a wire status message.
 *   https://developer.casambi.com/#ws-wire-status-types
 */
export class CasambiNetworkSession extends events.EventEmitter {
  wireId: number;

  constructor(
    public api: CasambiAPI,
    public networkInfo,
    public sessionId: string) {
    super();
    this.wireId = 0;
    api.connection.on('close', this.onConnectionClose.bind(this));
    api.connection.on('message', this.onMessage.bind(this));
    this.setMaxListeners(100);
  }

  get(path: string, config?: AxiosRequestConfig): Promise<any> {
    return this.api.get(`/networks/${this.networkInfo.id}${path}`, {
      headers: {'X-Casambi-Session': this.sessionId},
      ...config,
    });
  }

  /**
   * https://developer.casambi.com/#request-network-information
   */
  requestInformation(): Promise<any> {
    return this.get('');
  }

  /**
   * https://developer.casambi.com/#request-network-unit-list
   */
  requestUnitList(): Promise<any> {
    return this.get('/units');
  }

  /**
   * https://developer.casambi.com/#request-network-unit-state
   * @param unitId 
   */
  requestUnitState(unitId: number): Promise<any> {
    return this.get(`/units/${unitId}/state`);
  }

  /**
   * https://developer.casambi.com/#request-network-state
   */
  requestState(): Promise<any> {
    return this.get('/state');
  }

  /**
   * https://developer.casambi.com/#request-network-groups
   */
  requestGroups(): Promise<any> {
    return this.get('/groups');
  }

  /**
   * https://developer.casambi.com/#request-network-scenes
   */
  requestScenes(): Promise<any> {
    return this.get('/scenes');
  }

  /**
   * https://developer.casambi.com/#request-network-datapoints
   * @param filterOptions 
   */
  requestDatapoints(filterOptions: string): Promise<any> {
    return this.get(`/datapoints?${filterOptions}`);
  }

  /**
   * https://developer.casambi.com/#request-network-unit-icon
   * @param unitId 
   */
  requestUnitIcon(unitId: number): Promise<ArrayBuffer> {
    return this.get(`/units/${unitId}/icon`, {
      responseType: 'arraybuffer',
    });
  }

  /**
   * https://developer.casambi.com/#request-network-gallery
   */
  requestGallery(): Promise<any> {
    return this.get('/gallery');
  }

  /**
   * https://developer.casambi.com/#request-network-image
   * @param imageId 
   */
  requestImage(imageId: string): Promise<ArrayBuffer> {
    return this.get(`/images/${imageId}`, {
      responseType: 'arraybuffer',
    });
  }

  /**
   * Open connection wire for this network.
   * Needs to be called to start monitoring network events.
   */
  openWire(): Promise<void> {
    if (this.wireId > 0) {
      return Promise.resolve();
    }
    return this.api.connection.openWire(this.networkInfo.id, this.sessionId)
      .then((wireId: number) => {
        this.wireId = wireId;
        this.emit('wireOpen');
      });
  }

  /**
   * Close connection wire for this network.
   */
  closeWire(): Promise<void> {
    if (this.wireId === 0) {
      return Promise.resolve();
    }
    return this.api.connection.closeWire(this.wireId)
      .then(() => {
        this.emit('wireClose');
        this.wireId = 0;
      });
  }

  /**
   * Control a Casambi unit (turn light on/off, etc.) on this network.
   * Opens a wire first, if needed.
   * https://developer.casambi.com/#ws-control-messages
   * @param unitId 
   * @param targetControls 
   */
  sendControlUnit(unitId: number, targetControls): Promise<void> {
    return this.openWire().then(() =>
      this.api.connection.sendControlUnit(this.wireId, unitId, targetControls));
  }

  private onConnectionClose(/*code: number, reason: string*/) {
    this.wireId = 0;
  }

  private onMessage(message) {
    if (message.wire === this.wireId) {
      switch (message.method) {
        case 'unitChanged':
        case 'peerChanged':
        case 'networkUpdated': {
          this.emit(message.method, message);
          break;
        }
      }
      if ('wireStatus' in message) {
        this.emit('wireStatus', message.wireStatus);
      }
    }
  }
}

/**
 * Represents the result of a user login.
 * Returned by CasambiAPI.createUserSession().
 * https://developer.casambi.com/#create-user-session
 */
export class CasambiUserSession {
  constructor(
    public api: CasambiAPI,
    public sites,
    public networks,
    public sessionId: string) {
  }

  /**
   * Returns an array of CasambiSite objects for user's sites.
   */
  createSites(): CasambiSite[] {
    const sites: CasambiSite[] = [];
    for (const siteKey in this.sites) {
      sites.push(new CasambiSite(this, this.sites[siteKey]));
    }
    return sites;
  }

  /**
   * Create network session objects for all networks of this user.
   */
  createNetworkSessions(): CasambiNetworkSession[] {
    const sessions: CasambiNetworkSession[] = [];
    for (const networkKey in this.networks) {
      sessions.push(new CasambiNetworkSession(this.api, this.networks[networkKey], this.sessionId));
    }
    return sessions;
  }
}

/**
 * Represents a single site belonging to a user.
 * Returned by CasambiUserSession.createSites().
 */
export class CasambiSite {
  constructor(
    public session: CasambiUserSession,
    public siteInfo) {
  }

  /**
   * Create network session objects for all networks of this site.
   */
  createNetworkSessions(): CasambiNetworkSession[] {
    const sessions: CasambiNetworkSession[] = [];
    for (const networkKey in this.siteInfo.networks) {
      const networkInfo = this.siteInfo.networks[networkKey];
      sessions.push(new CasambiNetworkSession(this.session.api, networkInfo, this.session.sessionId));
    }
    return sessions;
  }
}

/**
 * Represents a WebSocket connection to the Casambi Cloud API.
 * https://developer.casambi.com/#ws-service
 * 
 * Events:
 * - "open"
 *   Connection to the server established.
 * - "close"
 *   Connection lost.
 * - "timeout"
 *   Connection timed out. Followed by "close".
 * - "message"
 *   Message received from the server.
 */
export class CasambiConnection extends events.EventEmitter {
  ws?: WebSocket;
  private nextWireId: number;
  private pingInterval?: NodeJS.Timeout;
  private pongTimeout?: NodeJS.Timeout;

  constructor(public apiKey: string) {
    super();
    this.ws = undefined;
    this.nextWireId = 1;
  }

  /**
   * Connect the WebSocket to the server.
   * Must be followed immediately by openWire().
   */
  open(): Promise<void> {
    switch (this.ws ? this.ws.readyState : WebSocket.CLOSED) {
      case WebSocket.CONNECTING: // already connecting
        break;
      case WebSocket.OPEN: // already connected
        return Promise.resolve();
      default: // no websocket, disconnecting or disconnected
        this.ws = new WebSocket('wss://door.casambi.com/v1/bridge/', this.apiKey);
        this.ws.once('open', this.onOpen.bind(this));
    }
    return new Promise((resolve, reject) => {
      this.ws.once('close', (code: number, reason: string) => {
        reject(reason);
      });
      this.ws.once('open', () => {
        resolve();
      });
    });
  }

  /**
   * Close the WebSocket connection to the server.
   */
  close() {
    if (this.ws) {
      this.ws.close();
    }
  }

  sendPing() {
    this.ws.ping();
  }

  newWireId(): number {
    const wireId = this.nextWireId;
    this.nextWireId = wireId % MAX_WIRE_ID + 1;
    return wireId;
  }

  /**
   * Open wire for a Casambi network session.
   * Connects to the server first, if needed.
   * Promise resolves with the newly assigned wire ID.
   * https://developer.casambi.com/#ws-open-message
   * @param networkId 
   * @param sessionId 
   */
  openWire(networkId: string, sessionId: string): Promise<number> {
    const openMessage = {
      method: 'open',
      id: networkId,
      session: sessionId,
      ref: Math.random().toString(36).substr(2),
      wire: this.newWireId(),
      type: 1,
    };
    return this.open().then(() => {
      return new Promise((resolve, reject) => {
        const messageHandler = (message) => {
          if ('wireStatus' in message && message.ref === openMessage.ref) {
            this.removeListener('message', messageHandler);
            if (message.wireStatus === 'openWireSucceed') {
              resolve(openMessage.wire);
            } else {
              reject(message.wireStatus);
            }
          }
        };
        this.on('message', messageHandler);
        this.sendMessage(openMessage);
      });
    });
  }

  /**
   * Close/pause a wire.
   * https://developer.casambi.com/#ws-close-message
   * @param wireId 
   */
  closeWire(wireId: number): Promise<void> {
    return this.sendMessage({
      method: 'close',
      wire: wireId,
    });
  }

  /**
   * Control a Casambi unit (turn light on/off, etc.).
   * https://developer.casambi.com/#ws-control-messages
   * @param wireId 
   * @param unitId 
   * @param targetControls 
   */
  sendControlUnit(wireId: number, unitId: number, targetControls): Promise<void> {
    return this.sendMessage({
      method: 'controlUnit',
      wire: wireId,
      id: unitId,
      targetControls: targetControls,
    });
  }

  /**
   * Send raw json to the server.
   * @param message 
   */
  sendMessage(message): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.send(decodeURIComponent(escape(JSON.stringify(message))), (error?) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private onOpen() {
    this.ws.once('close', this.onClose.bind(this));
    this.ws.on('pong', this.onPong.bind(this));
    this.ws.on('message', this.onMessage.bind(this));
    this.pingInterval = setInterval(this.sendPing.bind(this), PING_INTERVAL);
    this.onPong();
    this.emit('open');
  }

  private onClose(code: number, reason: string) {
    clearInterval(this.pingInterval!);
    clearTimeout(this.pongTimeout!);
    this.ws = undefined;
    this.emit('close', code, reason);
  }

  private onPong() {
    clearTimeout(this.pongTimeout!);
    this.pongTimeout = setTimeout(() => {
      this.emit('timeout');
      this.ws.terminate();
    }, PONG_TIMEOUT);
  }

  private onMessage(data: string) {
    this.emit('message', JSON.parse(data));
  }
}
