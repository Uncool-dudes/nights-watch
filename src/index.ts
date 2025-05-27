
import { Hono } from 'hono';
import { spawn } from 'child_process';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { access } from 'fs/promises';
import { constants } from 'fs';


const app = new Hono();
app.use('*', cors({ origin: '*' }));


function createStockfish() {
  const engine = spawn('/app/stockfish/stockfish-ubuntu-x86-64-avx2');

  let alive = true;

  engine.on('error', (err) => {
    console.error('Stockfish process error:', err);
    alive = false;
  });

  engine.on('exit', (code, signal) => {
    console.log(`Stockfish process exited with code ${code} signal ${signal}`);
    alive = false;
  });

  return {
    send: (cmd: string) => {
      if (!alive) {
        console.warn('Attempted to send command to closed Stockfish process');
        return;
      }
      engine.stdin.write(cmd + '\n');
    },
    onOutput: (callback: (output: string) => void) => {
      engine.stdout.on('data', (data) => {
        callback(data.toString());
      });
    },
    terminate: () => {
      alive = false;
      engine.stdin.end();
      engine.kill();
    }
  };
}

app.post('/eval', async (c) => {
  const body = await c.req.json();
  const fens: string[] = body.fens;
  const depth: string = body.depth || '15';
  if (!Array.isArray(fens) || fens.length === 0) {
    return c.text('Invalid or empty FEN array', 400);
  }
  const evaluations = await Promise.all(
    fens.map((fen) => {
      return new Promise((resolve) => {
        const stockfish = createStockfish();
        let lastEval = '';
        let bestmove = '';
        stockfish.onOutput((line) => {
          if (line.includes('score')) {
            lastEval = line.trim();
          }
          if (line.includes('bestmove')) {
            const bestMoveMatch = line.match(/bestmove (\S+)/);
            if (bestMoveMatch) {
              bestmove = bestMoveMatch[1];
            }
            const scoreMatch = lastEval.match(/score (cp|mate) (-?\d+)/);
            let evaluation = null;
            if (scoreMatch) {
              const [_, type, value] = scoreMatch;
              evaluation = type === 'cp' ? parseInt(value, 10) / 100 : `mate in ${value}`;
            }
            stockfish.terminate();
            resolve({ fen, evaluation, bestmove });
          }
        });
        stockfish.send('uci');
        stockfish.send(`position fen ${fen}`);
        stockfish.send(`go depth ${depth}`);
      });
    })
  );
  return c.json({ evaluations });
});



async function checkStockfishRunnable(path = '/app/stockfish/stockfish-ubuntu-x86-64-avx2'): Promise<boolean> {
  return new Promise((resolve) => {
    const engine = spawn(path);

    let responded = false;

    // Timeout in case Stockfish doesn't respond
    const timeout = setTimeout(() => {
      if (!responded) {
        engine.kill();
        resolve(false);
      }
    }, 3000); // 3 seconds timeout

    engine.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('uciok')) {
        responded = true;
        clearTimeout(timeout);
        engine.kill();
        resolve(true);
      }
    });

    engine.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });

    // Send 'uci' command to trigger the response
    engine.stdin.write('uci\n');
  });
}




app.get('/', async (c) => {
  const stockfishPath = '/app/stockfish/stockfish-ubuntu-x86-64-avx2';

  try {
    await access(stockfishPath, constants.F_OK | constants.X_OK);
  } catch {
    return c.json({ status: 'error', message: `Stockfish binary missing or not executable at ${stockfishPath}` }, 500);
  }

  const runnable = await checkStockfishRunnable(stockfishPath);

  if (runnable) {
    return c.json({ status: 'ok', message: 'Stockfish is runnable and responding.' });
  } else {
    return c.json({ status: 'error', message: 'Stockfish failed to respond to UCI command.' }, 500);
  }
});


const port = process.env.PORT || 3000;
serve({ fetch: app.fetch, port: Number(port) });
console.log(`🚀 Hono server running at http: ${port}`);
export default app;
