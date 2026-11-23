import { registerRootComponent } from 'expo';
import './src/location';          // registers the background location task before the app renders
import App from './src/App';
registerRootComponent(App);
