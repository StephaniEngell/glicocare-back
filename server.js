import 'dotenv/config';
import http from 'node:http';
import { handler } from './api/[...path].js';

const port = Number(process.env.PORT || 3001);
const server = http.createServer((req, res) => handler(req, res));
server.listen(port, () => console.log(`GlicoCare API disponível na porta ${port}`));
