/// <reference types="vite/client" />

// Облегчённая сборка hls.js (без субтитров и DRM) — те же типы, что у полной.
declare module 'hls.js/light' {
  import Hls from 'hls.js';
  export default Hls;
}
