import Foundation
import React
import CocoaMQTT
import Network

@objc(MqttNative)
class MqttNative: RCTEventEmitter, CocoaMQTTDelegate {

  // MARK: - Properties

  /// Multi-instance dictionary: clientId → CocoaMQTT
  private var clients: [String: CocoaMQTT] = [:]
  private var resolvers: [String: RCTPromiseResolveBlock] = [:]
  private var rejecters: [String: RCTPromiseRejectBlock] = [:]
  private var hasListeners = false

  /// Network monitors per clientId (used to wait for network before connecting)
  private var monitors: [String: NWPathMonitor] = [:]
  private let monitorQueue = DispatchQueue(label: "mqtt.network.monitor")

  /// Reconnect timers per clientId (manual reconnect after disconnect)
  private var reconnectTimers: [String: DispatchWorkItem] = [:]

  /// Store connect params for reconnect
  private struct MQTTParams {
    let host: String
    let port: UInt16
    let username: String
    let password: String
    let tls: Bool
  }
  private var connectParams: [String: MQTTParams] = [:]

  // MARK: - RCTEventEmitter Setup

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    return ["mqtt_status", "mqtt_message", "mqtt_disconnected"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  override func addListener(_ eventName: String) {
    super.addListener(eventName)
  }

  override func removeListeners(_ count: Double) {
    super.removeListeners(count)
  }

  // MARK: - Event Emitter Helper

  /// All emits include a clientId, allowing routing on the JS side.
  private func emit(_ name: String, clientId: String, extra: [String: Any] = [:]) {
    guard hasListeners else { return }
    var body: [String: Any] = ["clientId": clientId]
    body.merge(extra) { _, new in new }
    sendEvent(withName: name, body: body)
  }

  // MARK: - Network Monitor Helper

  /// Cancel and remove any existing NWPathMonitor for a given clientId.
  private func cancelMonitor(clientId: String) {
    monitors[clientId]?.cancel()
    monitors.removeValue(forKey: clientId)
  }

  /// Cancel any pending reconnect timer for a given clientId.
  private func cancelReconnectTimer(clientId: String) {
    reconnectTimers[clientId]?.cancel()
    reconnectTimers.removeValue(forKey: clientId)
  }

  /// Wait until network is available, then call connect() on the given CocoaMQTT instance.
  /// If network is already available, connects immediately on first callback.
  private func waitForNetworkThenConnect(mqtt: CocoaMQTT, clientId: String) {
    cancelMonitor(clientId: clientId)
    cancelReconnectTimer(clientId: clientId)

    print("[MQTT DEBUG] waitForNetworkThenConnect called for \(clientId)")

    let monitor = NWPathMonitor()
    monitors[clientId] = monitor

    var didConnect = false  // ✅ Only fire connect once per monitor

    monitor.pathUpdateHandler = { [weak self] path in
      guard let self = self else { return }

      if path.status == .satisfied && !didConnect {
        didConnect = true
        // Network is available — cancel monitor and attempt MQTT connect
        self.cancelMonitor(clientId: clientId)

        DispatchQueue.main.async {
          // Guard: make sure this client is still the active one
          guard self.clients[clientId] === mqtt else {
            print("[MQTT DEBUG] client changed, skip connect for \(clientId)")
            return
          }

          let scheme = mqtt.enableSSL ? "ssl" : "tcp"
          print("[MQTT DEBUG] network ready, connecting \(scheme)://\(mqtt.host):\(mqtt.port)")
          self.emit("mqtt_status", clientId: clientId,
                    extra: ["status": "CONNECTING \(scheme)://\(mqtt.host):\(mqtt.port)"])

          if !mqtt.connect() {
            print("[MQTT DEBUG] connect() returned false for \(clientId)")
            self.rejecters[clientId]?("MQTT_CONNECT_FAIL", "connect() returned false", nil)
            self.resolvers.removeValue(forKey: clientId)
            self.rejecters.removeValue(forKey: clientId)
            self.clients.removeValue(forKey: clientId)
          }
        }
      } else if path.status != .satisfied {
        didConnect = false  // Reset so we retry when network comes back
        DispatchQueue.main.async {
          print("[MQTT DEBUG] waiting for network... \(clientId)")
          self.emit("mqtt_status", clientId: clientId,
                    extra: ["status": "WAITING_FOR_NETWORK"])
        }
      }
    }

    monitor.start(queue: monitorQueue)
  }

  /// Schedule a manual reconnect after a delay using stored params.
  private func scheduleReconnect(clientId: String, delay: TimeInterval = 3.0) {
    cancelReconnectTimer(clientId: clientId)
    guard let params = connectParams[clientId] else { return }

    print("[MQTT DEBUG] scheduleReconnect in \(delay)s for \(clientId)")

    let item = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      guard self.connectParams[clientId] != nil else { return } // cancelled

      // Rebuild CocoaMQTT instance and wait for network
      let m = self.buildMQTTClient(clientId: clientId, params: params)
      self.clients[clientId] = m
      self.waitForNetworkThenConnect(mqtt: m, clientId: clientId)
    }

    reconnectTimers[clientId] = item
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
  }

  /// Build a CocoaMQTT client from stored params (no autoReconnect — we manage it).
  private func buildMQTTClient(clientId: String, params: MQTTParams) -> CocoaMQTT {
    // ✅ Use original clientId — same as Android (no modification)
    let m = CocoaMQTT(clientID: clientId, host: params.host, port: params.port)
    m.delegate = self
    m.cleanSession = true
    m.keepAlive = 20
    m.autoReconnect = false

    if !params.username.isEmpty { m.username = params.username }
    if !params.password.isEmpty { m.password = params.password }

    if params.tls {
      m.enableSSL = true
      m.allowUntrustCACertificate = true

      // ✅ Server requires ALPN "mqtt" during TLS handshake (returns alert 120 without it)
      m.sslSettings = [
        "kCFStreamSSLPeerName": params.host as NSObject,
        "GCDAsyncSocketSSLALPNProtocols": ["mqtt"] as NSObject
      ]
    }

    print("[MQTT DEBUG] built client: \(clientId) → \(params.host):\(params.port) tls=\(params.tls) user=\(params.username)")
    return m
  }

  // MARK: - Close a Single Client

  private func closeClient(clientId: String, reason: String = "closed") {
    // Cancel any pending network monitor and reconnect timer
    cancelMonitor(clientId: clientId)
    cancelReconnectTimer(clientId: clientId)

    if let old = clients[clientId] {
      old.delegate = nil   // Cut off callbacks to prevent stale events
      old.disconnect()
      clients.removeValue(forKey: clientId)
    }

    if let rej = rejecters[clientId] {
      rej("MQTT_CLOSED", reason, nil)
    }
    resolvers.removeValue(forKey: clientId)
    rejecters.removeValue(forKey: clientId)
  }

  // MARK: - RN Exposed Methods

  @objc(connect:port:clientId:username:password:useTls:resolver:rejecter:)
  func connect(
    host: String,
    port: NSNumber,
    clientId: String,
    username: String,
    password: String,
    useTls: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let h = host.trimmingCharacters(in: .whitespacesAndNewlines)
    let p = UInt16(truncating: port)
    let tls = useTls.boolValue

    // If a connection already exists for the same clientId, close it first.
    closeClient(clientId: clientId, reason: "reconnecting")

    // Save promise handlers
    resolvers[clientId] = resolve
    rejecters[clientId] = reject

    // ✅ Store params so we can rebuild client on reconnect
    let params = MQTTParams(host: h, port: p, username: username, password: password, tls: tls)
    connectParams[clientId] = params

    // Build MQTT client (autoReconnect=false — we manage reconnect manually)
    let m = buildMQTTClient(clientId: clientId, params: params)
    clients[clientId] = m

    // ✅ Wait for network before connecting — fixes "No connected path" error
    waitForNetworkThenConnect(mqtt: m, clientId: clientId)
  }

  @objc(subscribe:qos:clientId:resolver:rejecter:)
  func subscribe(
    topic: String,
    qos: NSNumber,
    clientId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let m = clients[clientId], m.connState == .connected else {
      reject("MQTT_NOT_CONNECTED", "Client \(clientId) not connected", nil)
      return
    }
    let q = CocoaMQTTQoS(rawValue: UInt8(truncating: qos)) ?? .qos0
    m.subscribe(topic, qos: q)
    emit("mqtt_status", clientId: clientId, extra: ["status": "SUBSCRIBED \(topic)"])
    resolve(true)
  }

  @objc(publish:payload:qos:retained:clientId:resolver:rejecter:)
  func publish(
    topic: String,
    payload: String,
    qos: NSNumber,
    retained: Bool,
    clientId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let m = clients[clientId], m.connState == .connected else {
      reject("MQTT_NOT_CONNECTED", "Client \(clientId) not connected", nil)
      return
    }
    let q = CocoaMQTTQoS(rawValue: UInt8(truncating: qos)) ?? .qos0
    m.publish(topic, withString: payload, qos: q, retained: retained)
    resolve(true)
  }

  @objc(disconnect:resolver:rejecter:)
  func disconnect(
    _ clientId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    connectParams.removeValue(forKey: clientId)  // ✅ Stop auto-reconnect
    closeClient(clientId: clientId, reason: "user disconnect")
    emit("mqtt_status", clientId: clientId, extra: ["status": "DISCONNECTED"])
    resolve(true)
  }

  /// Disconnect all connections (used when exiting/logging out of the app)
  @objc(disconnectAll:rejecter:)
  func disconnectAll(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let ids = Array(clients.keys)
    ids.forEach {
      connectParams.removeValue(forKey: $0)  // ✅ Stop auto-reconnect for all
      closeClient(clientId: $0, reason: "disconnectAll")
    }
    resolve(true)
  }

  // MARK: - CocoaMQTTDelegate

  func mqtt(_ mqtt: CocoaMQTT, didConnect host: String, port: Int) {
    print("[MQTT DEBUG] ✅ TCP connected \(host):\(port)")
  }

  func mqtt(_ mqtt: CocoaMQTT, didConnectAck ack: CocoaMQTTConnAck) {
    print("[MQTT DEBUG] ✅ didConnectAck ack=\(ack)")
    let cid = mqtt.clientID
    guard clients[cid] === mqtt else { return }

    if ack == .accept {
      emit("mqtt_status", clientId: cid,
           extra: ["status": "CONNECTED \(mqtt.host):\(mqtt.port)"])
      // ✅ resolver may already be nil on auto-reconnect — safe optional call
      resolvers[cid]?(true)
    } else {
      emit("mqtt_status", clientId: cid,
           extra: ["status": "CONNECT_FAILED ack=\(ack)"])
      rejecters[cid]?("MQTT_CONNACK_FAIL", "connack=\(ack)", nil)
      emit("mqtt_disconnected", clientId: cid, extra: ["error": "connack=\(ack)"])
    }

    resolvers.removeValue(forKey: cid)
    rejecters.removeValue(forKey: cid)
  }

  func mqtt(_ mqtt: CocoaMQTT, didReceiveMessage message: CocoaMQTTMessage, id: UInt16) {
    let cid = mqtt.clientID
    guard clients[cid] === mqtt else { return }

    var bytes = message.payload

    // Strip trailing \r \n \0
    while bytes.last == 13 || bytes.last == 10 || bytes.last == 0 {
      bytes.removeLast()
    }

    let payloadStr: String
    if bytes.isEmpty {
      payloadStr = ""
    } else if let s = String(bytes: bytes, encoding: .utf8) {
      payloadStr = s
    } else {
      // Lossy fallback — damaged bytes replaced with replacement character
      payloadStr = String(decoding: bytes, as: UTF8.self)
    }

    print("[MQTT RAW] topic=\(message.topic)")
    print("[MQTT RAW] payload=\(payloadStr)")

    emit("mqtt_message", clientId: cid, extra: [
      "topic": message.topic,
      "payload": payloadStr
    ])
  }

  func mqttDidDisconnect(_ mqtt: CocoaMQTT, withError err: Error?) {
    print("[MQTT DEBUG] ❌ mqttDidDisconnect err=\(String(describing: err))")
    let cid = mqtt.clientID
    guard clients[cid] === mqtt else { return }

    let nsErr = err as NSError?
    let msg = err?.localizedDescription ?? "disconnected"
    let detail = nsErr != nil
      ? "\(msg) (domain=\(nsErr!.domain) code=\(nsErr!.code))"
      : msg

    // Reject pending promise if still waiting (e.g. connect() never succeeded)
    if let rej = rejecters[cid] {
      rej("MQTT_DISCONNECTED", detail, err)
      resolvers.removeValue(forKey: cid)
      rejecters.removeValue(forKey: cid)
    }

    emit("mqtt_disconnected", clientId: cid, extra: ["error": detail])
    emit("mqtt_status", clientId: cid, extra: ["status": "DISCONNECTED \(detail)"])

    // ✅ Manual reconnect — only if we still have params (i.e. user didn't explicitly disconnect)
    if connectParams[cid] != nil {
      print("[MQTT DEBUG] disconnected, will reconnect in 3s for \(cid)")
      scheduleReconnect(clientId: cid, delay: 3.0)
    }
  }

  func mqtt(_ mqtt: CocoaMQTT, didStateChangeTo state: CocoaMQTTConnState) {
    let cid = mqtt.clientID
    guard clients[cid] === mqtt else { return }
    emit("mqtt_status", clientId: cid, extra: ["status": "STATE \(state)"])
  }

  /// ✅ Accept all TLS certificates (server uses valid Let's Encrypt cert, so this is safe)
  func mqtt(_ mqtt: CocoaMQTT, didReceive trust: SecTrust,
            completionHandler: @escaping (Bool) -> Void) {
    print("[MQTT DEBUG] ✅ didReceive trust called for \(mqtt.host)")
    completionHandler(true)
  }

  func mqtt(_ mqtt: CocoaMQTT, didPublishMessage message: CocoaMQTTMessage, id: UInt16) {}
  func mqtt(_ mqtt: CocoaMQTT, didPublishAck id: UInt16) {}
  func mqtt(_ mqtt: CocoaMQTT, didSubscribeTopics success: NSDictionary, failed: [String]) {}
  func mqtt(_ mqtt: CocoaMQTT, didUnsubscribeTopics topics: [String]) {}
  func mqttDidPing(_ mqtt: CocoaMQTT) {}
  func mqttDidReceivePong(_ mqtt: CocoaMQTT) {}
}