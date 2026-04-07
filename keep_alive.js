import express from 'express';
import https from 'https';
import http from 'http';

export default function keepAlive() {
    const app = express();
    const PORT = process.env.PORT || 5000;

    app.get('/', (req, res) => {
        res.send('Nuoh is running');
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });

    const SELF_URL = process.env.RENDER_EXTERNAL_URL;
    if (SELF_URL) {
        setInterval(() => {
            const lib = SELF_URL.startsWith('https') ? https : http;
            lib.get(SELF_URL, (res) => {
                console.log(`Keep-alive ping: ${res.statusCode}`);
            }).on('error', (err) => {
                console.error('Keep-alive ping failed:', err.message);
            });
        }, 14 * 60 * 1000);
    }
}
