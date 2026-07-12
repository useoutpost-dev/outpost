import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        basalt: '#141610',
        console: '#1D2018',
        bonewhite: '#EAE6D9',
        ash: '#8B9283',
        beacon: '#F2A93B',
        moss: '#8CA870',
        rust: '#C05B4D',
      },
      fontFamily: {
        display: ['"Clash Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        body: ['Switzer', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
