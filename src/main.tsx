import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

// Register a very small service worker to flush last edits on tab close.
if ('serviceWorker' in navigator) {
  // Do not await; fire-and-forget registration.
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
