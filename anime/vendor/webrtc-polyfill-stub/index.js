// Серверу WebRTC не нужен: webtorrent качает раздачи по TCP. Без RTCPeerConnection
// simple-peer просто не создаёт WebRTC-соединений, а нативный node-datachannel не ставится.
export const RTCPeerConnection = undefined;
export const RTCSessionDescription = undefined;
export const RTCIceCandidate = undefined;
export default {};
