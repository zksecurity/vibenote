import React from 'react';
import { createRoot } from 'react-dom/client';
import { ViewerApp } from './ViewerApp';
import './viewer.css';
import 'katex/dist/katex.min.css';

declare global {
  interface Window {
    VIBENOTE_VIEWER?: true;
  }
}

window.VIBENOTE_VIEWER = true;

let container = document.getElementById('root');
if (!container) {
  throw new Error('Viewer root element missing');
}

let root = createRoot(container);
root.render(<ViewerApp />);
