import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackHeaderProps,
} from '@react-navigation/native-stack';
import { StackHeader } from '../design/AppHeader';
import { HomeScreen } from '../design/HomeScreen';
import { TabBar } from '../design/TabBar';
import { c, statusBar } from '../design/tokens';
import { linking } from './linking';
import type { RootParams, TabParams } from './routes';
import { screens, tabScreens } from './screens';

const Stack = createNativeStackNavigator<RootParams>();
const Tab = createBottomTabNavigator<TabParams>();

const theme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: c.ground,
    card: c.ground,
    text: c.ink,
    border: c.line,
    primary: c.accent,
  },
};

function Tabs() {
  return (
    <Tab.Navigator
      tabBar={(p) => <TabBar {...p} />}
      screenOptions={{
        header: ({ navigation, route, options }) => (
          <StackHeader {...({ navigation, route, options } as unknown as NativeStackHeaderProps)} />
        ),
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
      <Tab.Screen name="Inbox" getComponent={tabScreens.Inbox} />
      <Tab.Screen name="Dashboard" getComponent={tabScreens.Dashboard} />
      <Tab.Screen name="Account" getComponent={tabScreens.Account} />
    </Tab.Navigator>
  );
}

export function AppNavigator() {
  return (
    <NavigationContainer theme={theme} linking={linking}>
      <Stack.Navigator
        screenOptions={{
          header: (p) => <StackHeader {...p} />,
          contentStyle: { backgroundColor: c.ground },
          animation: 'slide_from_right',
          statusBarStyle: statusBar === 'light-content' ? 'light' : 'dark',
        }}
      >
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        {screens.map(({ name, get }) => (
          <Stack.Screen key={name} name={name} getComponent={get} />
        ))}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
