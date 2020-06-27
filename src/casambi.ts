import events from 'events';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { default as WebSocket } from 'ws';

export const WIRE_ID = 1;
const PING_INTERVAL = 30000;
const PONG_TIMEOUT = PING_INTERVAL + 2000;

/**
 * Main object used to talk to the Casambi Cloud API.
 */
export class CasambiAPI {
  instance: AxiosInstance;

  /**
   * You'll need an API key to use this class. See:
   * https://developer.casambi.com/#api-get-started
   * @param apiKey 
   */
  constructor(public apiKey: string) {
    this.instance = axios.create({
      baseURL: 'https://door.casambi.com/v1',
      headers: {'X-Casambi-Key': apiKey},
    });
  }

  get(path: string, config?: AxiosRequestConfig): Promise<any> {
    return this.instance.get(path, config)
      .then((response: AxiosResponse) => response.data);
  }

  post(path: string, data, config?: AxiosRequestConfig): Promise<any> {
    return this.instance.post(path, data, config)
      .then((response: AxiosResponse) => response.data);
  }

  /**
   * Log into given Casambi Network and return the session.
   * https://developer.casambi.com/#create-network-session
   * @param email 
   * @param password 
   */
  createNetworkSession(email: string, password: string): Promise<CasambiNetworkSession> {
    return this.post('/networks/session', {
      email: email,
      password: password,
    }).then(response => {
      const networkId = Object.keys(response)[0];
      const sessionId = response[networkId]['sessionId'];
      return new CasambiNetworkSession(this, networkId, sessionId);
    });
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
 */
export class CasambiNetworkSession {
  constructor(
    public api: CasambiAPI,
    public networkId: string,
    public sessionId: string) {
  }

  private get(path: string, config?: AxiosRequestConfig): Promise<any> {
    return this.api.get(`/networks/${this.networkId}${path}`, {
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
   * Create a WebSocket connection.
   */
  createConnection(): CasambiConnection {
    return new CasambiConnection(this.api.apiKey, this.networkId, this.sessionId);
  }
}

/**
 * Represents a WebSocket connection to the Casambi Cloud API.
 * Create using CasambiNetworkSession.createConnection().
 * Call .connect() to actually connect to the server.
 * https://developer.casambi.com/#ws-service
 * 
 * Events:
 * - "open"
 *   Connected to the server, wire opened.
 * - "close"
 *   Connection lost.
 * - "timeout"
 *   Connection timed out. Followed by "close".
 * - "unitChanged", peerChanged", "networkUpdated"
 *   Received a network/unit event.
 *   https://developer.casambi.com/#ws-method-types
 * - "wireStatus"
 *   Received a wire status message.
 *   https://developer.casambi.com/#ws-wire-status-types
 * - "message"
 *   Generic event called for all received messages.
 */
export class CasambiConnection extends events.EventEmitter {
  ws: WebSocket;
  private pingInterval?: NodeJS.Timeout;
  private pongTimeout?: NodeJS.Timeout;

  constructor(
    public apiKey: string,
    public networkId: string,
    public sessionId: string) {    
    super();
  }

  private createConnectedWebSocket(): Promise<WebSocket> {
    // Creates a new WebSocket connection and opens a new wire.
    // https://developer.casambi.com/#ws-create-connection
    const apiKey = this.apiKey;
    const openMessage = {
      method: 'open',
      id: this.networkId,
      session: this.sessionId,
      ref: Math.random().toString(36).substr(2),
      wire: WIRE_ID,
      type: 1,
    };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://door.casambi.com/v1/bridge/', apiKey);
      ws.on('message', (data: string) => {
        const message = JSON.parse(data);
        if ('wireStatus' in message && message.ref === openMessage.ref) {
          if (message.wireStatus === 'openWireSucceed') {
            ws.removeAllListeners();
            resolve(ws);
          } else {
            reject(message.wireStatus);
          }
        }
      });
      ws.once('close', (code: number, reason: string) => {
        reject(reason);
      });
      ws.once('open', () => {
        ws.send(decodeURIComponent(escape(JSON.stringify(openMessage))));
      });
    });
  }

  /**
   * Connect to the Cloud server.
   * Must be called before sending any messages.
   * First messages received after connecting will be the states
   * of all units.
   */
  connect() {
    this.createConnectedWebSocket().then((ws: WebSocket) => {
      this.ws = ws;
      ws.once('close', this.onClose.bind(this));
      ws.on('pong', this.onPong.bind(this));
      ws.on('message', this.onMessage.bind(this));
      this.pingInterval = setInterval(this.sendPing.bind(this), PING_INTERVAL);
      this.onPong();
      this.emit('open');
    });
  }

  sendPing() {
    this.ws.ping();
  }

  /**
   * Send raw json to the server.
   * @param message 
   * @param callback callback(error?)
   */
  sendMessage(message, callback?) {
    this.ws.send(decodeURIComponent(escape(JSON.stringify(message))), callback);
  }

  /**
   * Control a Casambi unit (turn light on/off, etc.).
   * https://developer.casambi.com/#ws-control-messages
   * @param unitId 
   * @param targetControls 
   * @param callback callback(error?)
   */
  sendControlUnit(unitId: number, targetControls, callback?) {
    this.sendMessage({
      wire: WIRE_ID,
      method: 'controlUnit',
      id: unitId,
      targetControls: targetControls,
    }, callback);
  }

  private onClose(code: number, reason: string) {
    clearInterval(this.pingInterval!);
    clearTimeout(this.pongTimeout!);
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
    const message = JSON.parse(data);
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
    this.emit('message', message);
  }
}
