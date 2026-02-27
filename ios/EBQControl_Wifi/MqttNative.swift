import Foundation
import React
import CocoaMQTT

@objc(MqttNative)
class MqttNative: RCTEventEmitter, CocoaMQTTDelegate {

  // ✅ 多实例字典：clientId → CocoaMQTT
  private var clients: [String: CocoaMQTT] = [:]
  private var resolvers: [String: RCTPromiseResolveBlock] = [:]
  private var rejecters: [String: RCTPromiseRejectBlock] = [:]
  private var hasListeners = false

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    return ["mqtt_status", "mqtt_message", "mqtt_disconnected"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  // ✅ 必须调用 super
  override func addListener(_ eventName: String) {
    super.addListener(eventName)
  }
  override func removeListeners(_ count: Double) {
    super.removeListeners(count)
  }

  // ✅ 所有 emit 都带 clientId，JS 侧可以路由
  private func emit(_ name: String, clientId: String, extra: [String: Any] = [:]) {
    guard hasListeners else { return }
    var body: [String: Any] = ["clientId": clientId]
    body.merge(extra) { _, new in new }
    sendEvent(withName: name, body: body)
  }

  // MARK: - 关闭单个 client

  private func closeClient(clientId: String, reason: String = "closed") {
    if let old = clients[clientId] {
      old.delegate = nil   // ✅ 切断回调，防止旧事件污染
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

    // 如果同一个 clientId 已有连接，先关掉
    closeClient(clientId: clientId, reason: "reconnecting")

    // 保存 promise
    resolvers[clientId] = resolve
    rejecters[clientId] = reject

    let m = CocoaMQTT(clientID: clientId, host: h, port: p)
    m.delegate = self
    m.cleanSession = true
    m.keepAlive = 20
    m.autoReconnect = true
    m.autoReconnectTimeInterval = 3

    if !username.isEmpty { m.username = username }
    if !password.isEmpty { m.password = password }

 if tls {
    m.enableSSL = true
    m.allowUntrustCACertificate = true
}
    clients[clientId] = m

    let scheme = tls ? "ssl" : "tcp"
    emit("mqtt_status", clientId: clientId, extra: ["status": "CONNECTING \(scheme)://\(h):\(p)"])

    if !m.connect() {
      rejecters[clientId]?("MQTT_CONNECT_FAIL", "connect() returned false", nil)
      resolvers.removeValue(forKey: clientId)
      rejecters.removeValue(forKey: clientId)
      clients.removeValue(forKey: clientId)
    }
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
    closeClient(clientId: clientId, reason: "user disconnect")
    emit("mqtt_status", clientId: clientId, extra: ["status": "DISCONNECTED"])
    resolve(true)
  }

  // ✅ 断开全部连接（app 退出 / 登出时用）
  @objc(disconnectAll:rejecter:)
  func disconnectAll(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let ids = Array(clients.keys)
    ids.forEach { closeClient(clientId: $0, reason: "disconnectAll") }
    resolve(true)
  }

  // MARK: - CocoaMQTTDelegate

  func mqtt(_ mqtt: CocoaMQTT, didConnect host: String, port: Int) {}

  func mqtt(_ mqtt: CocoaMQTT, didConnectAck ack: CocoaMQTTConnAck) {
    let cid = mqtt.clientID
    guard clients[cid] === mqtt else { return }
    if ack == .accept {
      emit("mqtt_status", clientId: cid, extra: ["status": "CONNECTED \(mqtt.host):\(mqtt.port)"])
      resolvers[cid]?(true)
    } else {
      emit("mqtt_status", clientId: cid, extra: ["status": "CONNECT_FAILED \(ack)"])
      rejecters[cid]?("MQTT_CONNACK_FAIL", "connack=\(ack)", nil)
      emit("mqtt_disconnected", clientId: cid, extra: ["error": "connack=\(ack)"])
    }
    resolvers.removeValue(forKey: cid)
    rejecters.removeValue(forKey: cid)
  }

  func mqtt(_ mqtt: CocoaMQTT, didReceiveMessage message: CocoaMQTTMessage, id: UInt16) {
    let cid = mqtt.clientID
    guard clients[cid] === mqtt else { return }
    emit("mqtt_message", clientId: cid, extra: [
      "topic": message.topic,
      "payload": message.string ?? ""
    ])
  }

  func mqttDidDisconnect(_ mqtt: CocoaMQTT, withError err: Error?) {
    let cid = mqtt.clientID
    guard clients[cid] === mqtt else { return }
    let nsErr = err as NSError?
    let msg = err?.localizedDescription ?? "disconnected"
    let detail = nsErr != nil ? "\(msg) (domain=\(nsErr!.domain) code=\(nsErr!.code))" : msg
    if let rej = rejecters[cid] {
      rej("MQTT_DISCONNECTED", detail, err)
      resolvers.removeValue(forKey: cid)
      rejecters.removeValue(forKey: cid)
    }
    emit("mqtt_disconnected", clientId: cid, extra: ["error": detail])
    emit("mqtt_status", clientId: cid, extra: ["status": "DISCONNECTED \(detail)"])
  }

  func mqtt(_ mqtt: CocoaMQTT, didStateChangeTo state: CocoaMQTTConnState) {
    let cid = mqtt.clientID
    guard clients[cid] === mqtt else { return }
    emit("mqtt_status", clientId: cid, extra: ["status": "STATE \(state)"])
  }

  func mqtt(_ mqtt: CocoaMQTT, didReceive trust: SecTrust, completionHandler: @escaping (Bool) -> Void) {
    completionHandler(true)
  }

  func mqtt(_ mqtt: CocoaMQTT, didPublishMessage message: CocoaMQTTMessage, id: UInt16) {}
  func mqtt(_ mqtt: CocoaMQTT, didPublishAck id: UInt16) {}
  func mqtt(_ mqtt: CocoaMQTT, didSubscribeTopics success: NSDictionary, failed: [String]) {}
  func mqtt(_ mqtt: CocoaMQTT, didUnsubscribeTopics topics: [String]) {}
  func mqttDidPing(_ mqtt: CocoaMQTT) {}
  func mqttDidReceivePong(_ mqtt: CocoaMQTT) {}  // ← 只保留一个
}