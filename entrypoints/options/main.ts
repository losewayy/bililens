import { createApp } from 'vue';
import App from './App.vue';
import '@/assets/theme.css';
import './style.css';
import { applyFontScale } from '@/lib/fontScale';

/*
 * 设置页刻意**不**跟随用户选的字号档位，始终用默认。
 *
 * 理由：用户把侧边栏字号调到最大之后，如果设置页也跟着变大，
 * 他很可能连「字号」这一项都翻不到，等于把自己的退路堵死。
 * 字号只作用于侧边栏，这里只负责把档位清掉。
 */
await applyFontScale(true);

createApp(App).mount('#app');
