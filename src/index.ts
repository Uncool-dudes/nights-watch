
import { Hono } from 'hono';
import { spawn } from 'child_process';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { access } from 'fs/promises';
import { constants } from 'fs';

interface Move {
  position: string,
}

export interface EvaluatedMove extends Move {
  evaluation: string | number,
  bestMove: string
}

const app = new Hono();
app.use('*', cors({ origin: '*' }));
class StockfishPool {
  private pool: StockfishInstance[] = [];
  private maxPoolSize: number;
  private currentPoolSize = 0;

  constructor(maxPoolSize = 4) {
    this.maxPoolSize = maxPoolSize;
  }

  private createStockfish(): StockfishInstance {
    const engine = spawn('/app/stockfish/stockfish-ubuntu-x86-64-avx2');
    let alive = true;
    let ready = false;

    const instance = {
      engine,
      alive,
      ready,
      busy: false,
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
        this.currentPoolSize--;
      }
    };

    engine.on('error', (err) => {
      console.error('Stockfish process error:', err);
      alive = false;
      instance.alive = false;
      this.currentPoolSize--;
    });

    engine.on('exit', (code, signal) => {
      console.log(`Stockfish process exited with code ${code} signal ${signal}`);
      alive = false;
      instance.alive = false;
      this.currentPoolSize--;
    });

    // Initialize engine
    instance.onOutput((line) => {
      if (line.includes('uciok')) {
        ready = true;
        instance.ready = true;
      }
    });

    instance.send('uci');
    instance.send('setoption name Threads value 1'); // Use 1 thread per instance since we have multiple instances

    this.currentPoolSize++;
    return instance;
  }

  async acquire(): Promise<StockfishInstance> {
    // Try to find an available instance
    const available = this.pool.find(instance =>
      instance.alive && instance.ready && !instance.busy
    );

    if (available) {
      available.busy = true;
      return available;
    }

    // Create new instance if pool isn't full
    if (this.currentPoolSize < this.maxPoolSize) {
      const newInstance = this.createStockfish();
      this.pool.push(newInstance);

      // Wait for instance to be ready
      await new Promise<void>((resolve) => {
        const checkReady = () => {
          if (newInstance.ready) {
            resolve();
          } else {
            setTimeout(checkReady, 10);
          }
        };
        checkReady();
      });

      newInstance.busy = true;
      return newInstance;
    }

    // Wait for an instance to become available
    return new Promise((resolve) => {
      const checkAvailable = () => {
        const available = this.pool.find(instance =>
          instance.alive && instance.ready && !instance.busy
        );

        if (available) {
          available.busy = true;
          resolve(available);
        } else {
          setTimeout(checkAvailable, 10);
        }
      };
      checkAvailable();
    });
  }

  release(instance: StockfishInstance) {
    instance.busy = false;
    // Send isready to reset state
    instance.send('isready');
  }

  terminate() {
    this.pool.forEach(instance => instance.terminate());
    this.pool = [];
    this.currentPoolSize = 0;
  }
}

interface StockfishInstance {
  engine: any;
  alive: boolean;
  ready: boolean;
  busy: boolean;
  send: (cmd: string) => void;
  onOutput: (callback: (output: string) => void) => void;
  terminate: () => void;
}

// Global pool instance
const stockfishPool = new StockfishPool(4);

// Graceful shutdown
process.on('SIGTERM', () => {
  stockfishPool.terminate();
});

process.on('SIGINT', () => {
  stockfishPool.terminate();
});


app.post('/eval', async (c) => {
  console.log("Called")
  const { fens, depth = '15' } = await c.req.json() as { fens: string[], depth?: string };

  if (!Array.isArray(fens) || fens.length === 0) {
    return c.text('Invalid or empty FEN array', 400);
  }

  const batchSize = 4;
  const evaluatedMoves: EvaluatedMove[] = [];

  for (let i = 0; i < fens.length; i += batchSize) {
    const batch = fens.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (fen) => {
        const stockfish = await stockfishPool.acquire();

        return new Promise<EvaluatedMove>((resolve) => {
          let lastEval = '';
          let bestMove = '';
          let outputHandler: (data: Buffer) => void;

          const cleanup = () => {
            stockfish.engine.stdout.removeListener('data', outputHandler);
            stockfishPool.release(stockfish);
          };

          outputHandler = (data: Buffer) => {
            const line = data.toString();

            if (line.includes('score')) {
              lastEval = line.trim();
            }

            if (line.includes('bestmove')) {
              const bestMoveMatch = line.match(/bestmove (\S+)/);
              if (bestMoveMatch) {
                bestMove = bestMoveMatch[1];
              }

              const scoreMatch = lastEval.match(/score (cp|mate) (-?\d+)/);
              let evaluation: string | number = 'N/A';

              if (scoreMatch) {
                const [_, type, value] = scoreMatch;
                evaluation = type === 'cp' ? parseInt(value) / 100 : `mate in ${value}`;
              }

              cleanup();
              resolve({
                position: fen,
                evaluation,
                bestMove
              });
            }
          };

          stockfish.engine.stdout.on('data', outputHandler);

          stockfish.send(`position fen ${fen}`);
          stockfish.send(`go depth ${depth}`);

          setTimeout(() => {
            cleanup();
            resolve({
              position: fen,
              evaluation: 'timeout',
              bestMove: ''
            });
          }, 30000);
        });
      })
    );

    evaluatedMoves.push(...batchResults);
  }

  return c.json({ evaluatedMoves });
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


const port = parseInt(process.env.PORT!) | 3000;
serve({ fetch: app.fetch, port: Number(port) });
console.log(`🚀 Hono server running at http: ${port}`);
export default app;
