// У webtorrent нет своих типов: описываем ровно то, что нужно (остальное — any).
declare module 'webtorrent' {
  export default class WebTorrent {
    constructor(options?: Record<string, unknown>);
    [key: string]: any;
  }
}
