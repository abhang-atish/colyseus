import http from 'http';
import url from 'url';
import WebSocket, { MessageEvent } from 'ws';

import { Client, Protocol } from '..';

import { MatchMaker } from '../MatchMaker';
import { decode, send } from '../Protocol';
import { parseQueryString } from '../Utils';
import { ServerOptions } from './../Server';
import { Transport } from './Transport';

import { debugAndPrintError, debugMatchMaking } from './../Debug';
import { MatchMakeError } from '../errors/MatchMakeError';

function noop() {/* tslint:disable:no-empty */ }
function heartbeat() { this.pingCount = 0; }

export class WebSocketTransport extends Transport {
  protected wss: WebSocket.Server;

  protected pingInterval: NodeJS.Timer;
  protected pingTimeout: number;
  protected pingCountMax: number;

  constructor(matchMaker: MatchMaker, options: ServerOptions = {}, engine: any) {
    super(matchMaker);

    // disable per-message deflate
    options.perMessageDeflate = false;

    this.pingTimeout = (options.pingTimeout !== undefined)
      ? options.pingTimeout
      : 1500;
    this.pingCountMax = (options.pingCountMax !== undefined)
      ? options.pingCountMax
      : 2;

    this.wss = new engine(options);
    this.wss.on('connection', this.onConnection);
    this.server = options.server;

    if (this.pingTimeout > 0 && this.pingCountMax > 0) {
      this.autoTerminateUnresponsiveClients(this.pingTimeout, this.pingCountMax);
    }
  }

  public listen(port: number, hostname?: string, backlog?: number, listeningListener?: Function) {
    this.server.listen(port, hostname, backlog, listeningListener);
    return this;
  }

  public shutdown() {
    clearInterval(this.pingInterval);
    this.wss.close();
    this.server.close();
  }

  protected autoTerminateUnresponsiveClients(pingTimeout: number, pingCountMax: number) {
    // interval to detect broken connections
    this.pingInterval = setInterval(() => {
      this.wss.clients.forEach((client: Client) => {
        //
        // if client hasn't responded after the interval, terminate its connection.
        //
        if (client.pingCount >= pingCountMax) {
          return client.terminate();
        }

        client.pingCount++;
        client.ping(noop);
      });
    }, pingTimeout);
  }

  protected onConnection = async (client: Client, req?: http.IncomingMessage & any) => {
    // prevent server crashes if a single client had unexpected error
    client.on('error', (err) => debugAndPrintError(err.message + '\n' + err.stack));
    client.on('pong', heartbeat);

    // compatibility with ws / uws
    const upgradeReq = req || client.upgradeReq;
    const parsedURL = url.parse(upgradeReq.url);

    if (req.url.indexOf('/matchmake') !== -1) {
      debugMatchMaking('Received matchmake request: %s', req.url);
      this.handleMatchmake1(client, req);
    } else {
      this.handleMatchJoin(client, parsedURL, upgradeReq);
    }
  }

  private async handleMatchmake1(client: Client, req: http.IncomingMessage) {
    const matchedParams = req.url.match(this.matchMaker.allowedRoomNameChars);
    const method = matchedParams[matchedParams.length - 2];
    const name = matchedParams[matchedParams.length - 1];

    client.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(decode(event.data));
      this.handelMatchmake2(client, method, name, data);
    };
  }

  private async handelMatchmake2(client: Client, method, name, body) {
    console.log(body);
    try {
      if (this.matchMaker.exposedMethods.indexOf(method) === -1) {
        throw new MatchMakeError(`Invalid method "${method}"`, Protocol.ERR_MATCHMAKE_UNHANDLED);
      }
      const response = await this.matchMaker[method](name, body);

      client.send(JSON.stringify(response));

    } catch (e) {
      client.send(
        JSON.stringify(
          {
            code: e.code || Protocol.ERR_MATCHMAKE_UNHANDLED,
            error: e.message,
          },
        ));
    }
  }

  private async handleMatchJoin(client: Client, parsedURL: url.UrlWithStringQuery, upgradeReq: http.IncomingMessage) {
    const { sessionId } = parseQueryString(parsedURL.query);

    const processAndRoomId = parsedURL.pathname.match(/\/[a-zA-Z0-9_\-]+\/([a-zA-Z0-9_\-]+)$/);
    const roomId = processAndRoomId && processAndRoomId[1];

    const room = this.matchMaker.getRoomById(roomId);

    // set client id
    client.pingCount = 0;

    // set client options
    client.id = sessionId;
    client.sessionId = sessionId;

    try {
      await room._onJoin(client, upgradeReq);
    } catch (e) {
      debugAndPrintError(e.stack || e);
      send[Protocol.JOIN_ERROR](client, (e && e.message) || '');
      client.close(Protocol.WS_CLOSE_WITH_ERROR);
    }
  }
}
