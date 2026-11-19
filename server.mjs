import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('.',import.meta.url));
const port=Number(process.env.RADIO_LAB_PORT || 8876);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
http.createServer(async(req,res)=>{
 try{const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(relative==='/'?'/index.html':relative));
 if(!file.startsWith(root) || !(await stat(file)).isFile()){res.writeHead(404);res.end('Not found');return;}
 const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Radio lab: http://127.0.0.1:${port}`));
