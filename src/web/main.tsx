import { createRoot } from 'react-dom/client';
import App from './App';
import '../theme/styles.css';
import './source-app.css';
import './sidebar/ReposSidebar.css';
import './sidebar/MiniRepoTree.css';
import './items/pane-chrome.css';
import './builder.css';
createRoot(document.getElementById('root')!).render(<App />);
