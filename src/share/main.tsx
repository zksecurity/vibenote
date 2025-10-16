// Entry point for the public share viewer SPA rendered from share.html.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ShareApp } from './ShareApp';
import './share.css';

const mount = document.getElementById('share-root');
if (mount) {
  createRoot(mount).render(<ShareApp />);
}
