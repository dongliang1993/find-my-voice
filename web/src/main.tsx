import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import './index.css';

// Pauses every CSS animation while the window is hidden (see [data-hidden] in index.css).
const markHidden = () => { document.documentElement.toggleAttribute('data-hidden', document.hidden); };
document.addEventListener('visibilitychange', markHidden);
markHidden();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
