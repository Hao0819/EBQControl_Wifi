# EBQControl_Wifi

**EBQControl_Wifi** is a cross-platform **React Native** app (Android / iOS) used to control and monitor EBQ devices via **MQTT**.  
It includes device management, subscribe/publish messaging, and grid UI for single-phase and three-phase devices.

## Current Status
- ✅ **iOS** MQTT works on **1883 (TCP)** and **8883 (TLS)**
- ❌ **iOS** **8812** currently cannot connect (commonly a **protocol mismatch**: TLS port used as TCP, or the port is **MQTT over WebSocket**)

---

## Features
- **MQTT Device Management**
  - Add / edit / remove saved devices
  - Supports host, port, username/password, TLS toggle
- **Device UI**
  - Device list view
  - Device detail grid view
  - Three-phase view support
- **Subscribe & Publish**
  - Subscribe to device topics for live updates
  - Publish commands/messages to the server
- **Local Storage**
  - Persist device configurations using AsyncStorage

---

## Required Libraries (Install)

### 1) Install dependencies (recommended)
Normally you only need:
```bash
npm install

2) If setting up from scratch (manual install commands)
Navigation
npm install @react-navigation/native @react-navigation/native-stack
npm install react-native-screens react-native-safe-area-context
# Recommended for better navigation/animations
npm install react-native-gesture-handler react-native-reanimated

UI
npm install react-native-paper react-native-vector-icons

Storage
npm install @react-native-async-storage/async-storage

3) iOS Pods
After installing JS packages:
cd ios
pod install
cd ..

Run Android
Start Metro:
npx react-native start

Run:
npx react-native run-android


If you see "Unable to load script" on Android (device can’t reach Metro):
adb reverse tcp:8081 tcp:8081

Run iOS
Install pods:
cd ios
pod install
cd ..

Run on iOS (Debug):
npx react-native run-ios --mode Debug

If multiple iOS devices are connected, specify one:
npx react-native run-ios --mode Debug --device "Deng Kai D3’s iPad"

MQTT Notes (Example)
Typical EBQ topic pattern:
Subscribe: devices/<cpid>/<deviceId>/messages/events/#
Publish: devices/<cpid>/<deviceId>/messages/events
Ports
1883 – MQTT over TCP (no TLS)
8883 – MQTT over TLS
8812 – Unknown / server-specific (could be TLS or WebSocket).
If it’s WebSocket, native TCP MQTT clients will fail unless a WebSocket MQTT client is used.