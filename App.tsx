import React, { useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Provider as PaperProvider } from 'react-native-paper';

import { connectAndSubscribe } from './src/utils/MqttNativeClient';

import MqttDeviceListScreen from './src/screens/MqttDeviceListScreen';
import AddMqttDevice from './src/screens/AddMqttDevice';
import MqttDeviceGridScreen from './src/screens/MqttDeviceGridScreen';

const Stack = createNativeStackNavigator();

export default function App() {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    connectAndSubscribe({
      host: 'myebq.ddns.net',
      port: 8883,
      username: 'dengkai',
      password: 'myEBQ_dk',
      useTls: true,
      // topic: '#', // 先别订阅，先确认能 CONNECTED
    onStatus: (status: any) => console.log('STATUS:', status),
onMessage: (message: any) => console.log('MESSAGE:', message),
onError: (err: any) => console.log('ERROR:', err),
    });
  }, []);

  return (
    <PaperProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="MqttDeviceList">
          <Stack.Screen name="MqttDeviceList" component={MqttDeviceListScreen} options={{ title: 'EBQ Control' }} />
          <Stack.Screen name="AddMqttDevice" component={AddMqttDevice} options={{ title: 'Add Device' }} />
          <Stack.Screen name="MqttDeviceDetail" component={MqttDeviceGridScreen} options={{ title: 'Device Detail' }} />
        </Stack.Navigator>
      </NavigationContainer>
    </PaperProvider>
  );
}