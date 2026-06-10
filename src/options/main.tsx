import { render } from 'preact';
import '../styles/tokens.css';
import './options.css';
import { Options } from './Options';

render(<Options />, document.getElementById('root')!);
