export const macOfflinePolicy='(version 1)\n(allow default)\n(deny network-outbound (require-all (remote ip "*:*") (require-not (remote ip "127.0.0.1:*"))))\n';
