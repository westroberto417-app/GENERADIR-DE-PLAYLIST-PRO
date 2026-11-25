import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import { registerSW } from 'virtual:pwa-register';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { requestPersistentStorage, warmOfflineCache } from './services/offlineService';

// Request durable local storage immediately so browser won't evict IndexedDB / offline caches
void requestPersistentStorage();

// Register PWA Service Worker for full offline shell & Chrome/Edge standalone operation
registerSW({
  immediate: true,
  onRegisteredSW() {
    window.setTimeout(() => {
      void warmOfflineCache();
    }, 1200);
  },
});

createRoot(document.getElementById('root')!).render(<App />);
