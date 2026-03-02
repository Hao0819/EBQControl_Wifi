#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(MqttNative, RCTEventEmitter)

// ✅ Added clientId parameter
RCT_EXTERN_METHOD(connect:(NSString *)host
                  port:(nonnull NSNumber *)port
                  clientId:(NSString *)clientId
                  username:(NSString *)username
                  password:(NSString *)password
                  useTls:(nonnull NSNumber *)useTls
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
                  
// ✅ Added clientId parameter
RCT_EXTERN_METHOD(subscribe:(NSString *)topic
                  qos:(nonnull NSNumber *)qos
                  clientId:(NSString *)clientId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// ✅ Added clientId parameter
RCT_EXTERN_METHOD(publish:(NSString *)topic
                  payload:(NSString *)payload
                  qos:(nonnull NSNumber *)qos
                  retained:(BOOL)retained
                  clientId:(NSString *)clientId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// ✅ Added clientId parameter
RCT_EXTERN_METHOD(disconnect:(NSString *)clientId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// ✅ Added clientId parameter
RCT_EXTERN_METHOD(disconnectAll:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end