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

  get(path: string, config?: AxiosRequestConfig) {
    return this.instance.get(path, config)
      .then((response: AxiosResponse) => response.data);
  }

  post(path: string, data, config?: AxiosRequestConfig) {
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
   * Request information about the given fixture.
   * https://developer.casambi.com/#request-fixture-information
   * @param fixtureId 
   */
  requestFixtureInformation(fixtureId: number): Promise<unknown> {
    return this.get(`/fixtures/${fixtureId}`);
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

  private get(path: string) {
    return this.api.get(path, {
      headers: {'X-Casambi-Session': this.sessionId},
    });
  }

  /**
   * https://developer.casambi.com/#request-network-information
   */
  requestInformation() {
    return this.get(`/networks/${this.networkId}`);
  }

  /**
   * https://developer.casambi.com/#request-network-unit-list
   */
  requestUnitList() {
    return this.get(`/networks/${this.networkId}/units`);
  }

  /**
   * https://developer.casambi.com/#request-network-unit-state
   * @param unitId 
   */
  requestUnitState(unitId: number) {
    return this.get(`/networks/${this.networkId}/units/${unitId}/state`);
  }

  /**
   * https://developer.casambi.com/#request-network-state
   */
  requestState() {
    return this.get(`/networks/${this.networkId}/state`);
  }

  /**
   * Create a WebSocket connection and connect it to the server.
   */
  createConnection() {
    return new CasambiConnection(this.api.apiKey, this.networkId, this.sessionId);
  }
}

/**
 * Represents a WebSocket connection to the Casambi Cloud API.
 * Create using CasambiNetworkSession.createConnection().
 * https://developer.casambi.com/#ws-service
 * 
 * Extends EventEmitter providing following events:
 *
 * - open()
 *   The connection has been established.
 *
 * - close(code: number, reason: string)
 *   The connection has been closed.
 *   Re-connection happens automatically after a delay.
 *
 * - message(message)
 *   A notification has been received from the server.
 */
export class CasambiConnection extends events.EventEmitter {
  ws: WebSocket;
  pingInterval?: NodeJS.Timeout;
  pongTimeout?: NodeJS.Timeout;

  constructor(
    public apiKey: string,
    public networkId: string,
    public sessionId: string) {    
    super();
  }

  createConnectedWebSocket() {
    // Creates a new WebSocket connection and opens a new wire.
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
      this.ws.terminate();
    }, PONG_TIMEOUT);
  }

  private onMessage(data: string) {
    const message = JSON.parse(data);
    if ('method' in message) {
      switch (message.method) {
        case 'unitChanged':
        case 'peerChanged':
        case 'networkUpdated': {
          this.emit(message.method, message);
        }
      }
    } else if ('wireStatus' in message) {
      this.emit('wireStatus', message.wireStatus);
    }
  }
}
