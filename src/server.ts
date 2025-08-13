// Bake Forecaster API – 7:30pm cutover, all-days forecast
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true }); // allow all origins for quick testing

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEFAULT_ALPHA = 0.35;
const WASTE_TARGET_MIN = 30, WASTE_TARGET_MAX = 40;
const CUTOVER_TIME_HHMM = '19:30';

const OVEN_PROFILES = {
  regular: { tempF: 290, minutes: 16, batch_size: 6 },
  big: { tempF: 325, minutes: 16, batch_size: 6 },
} as const;

const DEFAULT_SKUS = [
  // Regular
  { name: 'Chocolate Chip', kind: 'regular' },
  { name: 'Royal Hawaiian', kind: 'regular' },
  { name: 'Toffee Crunch', kind: 'regular' },
  { name: 'Buttercake', kind: 'regular' },
  { name: 'Oatmeal Raisin', kind: 'regular' },
  { name: 'Snickerdoodle', kind: 'regular' },
  { name: 'M&M', kind: 'regular' },
  { name: 'White Chocolate Macadamia', kind: 'regular' },
  { name: 'Seasonal', kind: 'regular' },
  // Big
  { name: 'Peanut Butter Cup', kind: 'big' },
  { name: 'Smores', kind: 'big' },
  { name: 'Cookies & Cream', kind: 'big' },
  { name: 'Lemon Blueberry', kind: 'big' },
  { name: 'Cowboy', kind: 'big' },
  { name: 'Salted Caramel', kind: 'big' },
] as const;

const DEFAULT_STORES = [
  'Newport Beach',
  'Mission Viejo',
  'Fullerton',
  'Temecula',
  'Santa Ana',
  'San Diego',
];

const SCHEMA = `
create table if not exists stores(
  id serial primary key,
  name text unique not null
);
create table if not exists skus(
  id serial primary key,
  name text not null unique,
  kind text not null check (kind in ('regular','big')),
  batch_size int not null,
  oven_temp_f int not null,
  oven_minutes int not null
);
create table if not exists bakes(
  id bigserial primary key,
  store_id int references stores(id),
  sku_id int references skus(id),
  ts timestamptz not null,
  qty int not null
);
create table if not exists cutovers(
  store_id int references stores(id),
  date date not null,
  ts timestamptz not null,
  data jsonb not null,
  primary key(store_id,date)
);
create table if not exists closes(
  store_id int references stores(id),
  date date not null,
  ts timestamptz not null,
  leftover jsonb not null,
  waste jsonb not null,
  primary key(store_id,date)
);
create table if not exists eve_forecasts(
  store_id int references stores(id),
  sku_id int references skus(id),
  ewma double precision not null default 0,
  n int not null default 0,
  alpha double precision not null default ${DEFAULT_ALPHA},
  primary key(store_id, sku_id)
);
`;

app.get('/', async ()=> ({ ok:true, service:'bake-forecaster' }));
app.get('/admin/bootstrap', async ()=> { await pool.query(SCHEMA); return { ok:true }; });

app.post('/admin/seed-stores', async ()=> {
  for (const s of DEFAULT_STORES) {
    await pool.query(`insert into stores(name) values ($1) on conflict (name) do nothing`, [s]);
  }
  return { ok:true, stores: DEFAULT_STORES };
});

app.post('/admin/seed-skus', async ()=> {
  for (const s of DEFAULT_SKUS) {
    const p = OVEN_PROFILES[s.kind as 'regular'|'big'];
    await pool.query(
      `insert into skus(name, kind, batch_size, oven_temp_f, oven_minutes)
       values ($1,$2,$3,$4,$5)
       on conflict (name) do update set
         kind=excluded.kind,
         batch_size=excluded.batch_size,
         oven_temp_f=excluded.oven_temp_f,
         oven_minutes=excluded.oven_minutes`,
      [s.name, s.kind, p.batch_size, p.tempF, p.minutes]
    );
  }
  return { ok:true };
});

app.get('/stores', async ()=> (await pool.query(`select id, name from stores order by name`)).rows);
app.get('/skus',   async ()=> (await pool.query(`select id, name, kind, batch_size, oven_temp_f, oven_minutes from skus order by kind, name`)).rows);

app.post('/bake', async (req:any)=> {
  const b=req.body; const ts=b.ts? new Date(b.ts): new Date();
  return (await pool.query(
    `insert into bakes(store_id, sku_id, ts, qty) values ($1,$2,$3,$4) returning *`,
    [b.store_id, b.sku_id, ts, b.qty]
  )).rows[0];
});

app.post('/cutover', async (req:any)=> {
  const b=req.body;
  const data:Record<string,number> = {};
  for (const row of b.inventory) data[row.sku_id] = Number(row.on_hand||0);
  const ts=b.ts? new Date(b.ts): new Date();
  return (await pool.query(
    `insert into cutovers(store_id, date, ts, data)
     values ($1,$2,$3,$4)
     on conflict (store_id,date) do update set ts=excluded.ts, data=excluded.data
     returning *`,
    [b.store_id, b.date, ts, data]
  )).rows[0];
});

app.post('/close', async (req:any)=> {
  const b=req.body; const ts=b.ts? new Date(b.ts): new Date();
  const leftover:Record<string,number> = {}, waste:Record<string,number> = {};
  (b.leftover||[]).forEach((x:any)=> leftover[x.sku_id]=Number(x.qty||0));
  (b.waste||[]).forEach((x:any)=> waste[x.sku_id]=Number(x.qty||0));
  const r=(await pool.query(
    `insert into closes(store_id, date, ts, leftover, waste)
     values ($1,$2,$3,$4,$5)
     on conflict (store_id,date) do update set ts=excluded.ts, leftover=excluded.leftover, waste=excluded.waste
     returning *`,
    [b.store_id, b.date, ts, leftover, waste]
  )).rows[0];
  await rebuildForDay(b.store_id, b.date);
  return r;
});

async function rebuildForDay(store_id:number, dateStr:string){
  const cut = (await pool.query(`select data from cutovers where store_id=$1 and date=$2`, [store_id, dateStr])).rows[0];
  const cls = (await pool.query(`select leftover, waste from closes where store_id=$1 and date=$2`, [store_id, dateStr])).rows[0];
  if (!cut || !cls) return;

  const I = cut.data as Record<string,number>;
  const L = cls.leftover as Record<string,number>;
  const W = cls.waste as Record<string,number>;

  const bakes = (await pool.query(
    `select sku_id, coalesce(sum(qty),0) as qty
     from bakes
     where store_id=$1
       and ts >= $2::date + time '${CUTOVER_TIME_HHMM}'
       and ts < ($2::date + interval '1 day')
     group by sku_id`,
    [store_id, dateStr]
  )).rows;
  const POST:Record<string,number> = {}; bakes.forEach((r:any)=> POST[r.sku_id]=Number(r.qty));

  const skus = (await pool.query(`select id from skus`)).rows;

  for (const s of skus) {
    const id = s.id as number;
    const ic = Number(I[id]||0), bp = Number(POST[id]||0), lc = Number(L[id]||0), wp = Number(W[id]||0);
    const soldAfter = Math.max(0, ic + bp - lc - wp);

    const cur = (await pool.query(`select ewma, n, alpha from eve_forecasts where store_id=$1 and sku_id=$2`, [store_id, id])).rows[0];
    const prev = cur ? Number(cur.ewma) : soldAfter;
    const n    = cur ? Number(cur.n)   : 0;
    const alpha = cur?.alpha ?? DEFAULT_ALPHA;
    const next = alpha * soldAfter + (1 - alpha) * prev;

    await pool.query(
      `insert into eve_forecasts(store_id, sku_id, ewma, n, alpha)
       values ($1,$2,$3,$4,$5)
       on conflict (store_id, sku_id) do update set ewma=$3, n=$4, alpha=$5`,
      [store_id, id, next, n+1, alpha]
    );
  }
}

app.get('/plan/rest-of-night', async (req:any)=> {
  const store_id = Number(req.query.store_id);
  const date = req.query.date || new Date().toISOString().slice(0,10);

  const cut = (await pool.query(`select data from cutovers where store_id=$1 and date=$2`, [store_id, date])).rows[0];
  if (!cut) return { error: 'No cutover snapshot found for this store/date' };
  const onHand = cut.data as Record<string,number>;

  const f = (await pool.query(
    `select s.id as sku_id, s.name, s.kind, s.batch_size, s.oven_temp_f, s.oven_minutes,
            coalesce(e.ewma,0) as demand
     from skus s
     left join eve_forecasts e on e.store_id=$1 and e.sku_id=s.id
     order by s.name`,
    [store_id]
  )).rows;

  const totalDemand = f.reduce((sum:any, r:any)=> sum + Number(r.demand), 0);
  const wasteTarget = Math.round((WASTE_TARGET_MIN + WASTE_TARGET_MAX)/2);

  const items = f.map((r:any)=> {
    const share = totalDemand>0 ? Number(r.demand)/totalDemand : 1/f.length;
    const allocWaste = Math.round(wasteTarget * share);
    const need = Math.max(0, Math.ceil(Number(r.demand) + allocWaste - Number(onHand[r.sku_id]||0)));
    const batches = Math.ceil(need / Number(r.batch_size));
    const suggest_units = batches * Number(r.batch_size);
    const eta_minutes = batches * Number(r.oven_minutes);
    return {
      sku_id: r.sku_id,
      name: r.name,
      kind: r.kind,
      on_hand: Number(onHand[r.sku_id]||0),
      forecast_after_cutover: Number(r.demand),
      alloc_waste: allocWaste,
      batch_size: Number(r.batch_size),
      oven: { tempF: Number(r.oven_temp_f), minutes: Number(r.oven_minutes) },
      suggest_units, batches, eta_minutes
    };
  });

  const totalSuggest = items.reduce((s:any,p:any)=> s+p.suggest_units, 0);
  return { store_id, date, cutover_time: CUTOVER_TIME_HHMM, waste_window: [WASTE_TARGET_MIN, WASTE_TARGET_MAX], totalDemand, totalSuggest, items };
});

const port = Number(process.env.PORT || 3000);
app.listen({ port, host: '0.0.0.0' }).then(()=> app.log.info(`API on :${port}`));
