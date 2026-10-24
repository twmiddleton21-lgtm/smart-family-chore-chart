import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { dragScrollRequested, installDragScroll } from './lib/dragScroll';
import './styles/base.css';
import './styles/components.css';
import './styles/screens.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

// Kiosks whose touchscreen arrives as a mouse can opt in with ?dragscroll=1.
if (dragScrollRequested(window.location.search)) installDragScroll(window);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
