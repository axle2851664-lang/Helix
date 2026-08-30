import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import './ui/styles/helix.css';
import './ui/styles/shell.css';
import './ui/styles/app.css';
import './ui/styles/projects.css';

const container = document.getElementById('helix-root');
if (!container) {
  throw new Error('Helix: #helix-root container is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
