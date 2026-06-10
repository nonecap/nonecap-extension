import { render } from 'preact';
import '../styles/tokens.css';
import './popup.css';
import { Popup } from './Popup';

render(<Popup />, document.getElementById('root')!);
