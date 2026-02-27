#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(MqttNative, RCTEventEmitter)

// ✅ 加了 clientId 参数
RCT_EXTERN_METHOD(connect:(NSString *)host
                  port:(nonnull NSNumber *)port
                  clientId:(NSString *)clientId
                  username:(NSString *)username
                  password:(NSString *)password
                  useTls:(nonnull NSNumber *)useTls
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// ✅ 加了 clientId 参数
RCT_EXTERN_METHOD(subscribe:(NSString *)topic
                  qos:(nonnull NSNumber *)qos
                  clientId:(NSString *)clientId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// ✅ 加了 clientId 参数
RCT_EXTERN_METHOD(publish:(NSString *)topic
                  payload:(NSString *)payload
                  qos:(nonnull NSNumber *)qos
                  retained:(BOOL)retained
                  clientId:(NSString *)clientId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// ✅ disconnect 改为按 clientId 断开单个连接
RCT_EXTERN_METHOD(disconnect:(NSString *)clientId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// ✅ 新增：断开全部连接
RCT_EXTERN_METHOD(disconnectAll:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end