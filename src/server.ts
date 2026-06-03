import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import blocoFinanceiroRouter  from "./routes/blocoFinanceiro";
import blocoOperacionalRouter from "./routes/blocoOperacional";
import blocoGeralRouter       from "./routes/blocoGeral";
import authRouter             from "./routes/authRouter";
import { authenticateToken, requireLojaAccess, requireLevel } from "./middleware/auth";

dotenv.config();

const app = express();
app.disable('x-powered-by');

// CORS – origens permitidas via env var (vírgula-separadas); padrão = produção
const allowedOrigins = (process.env.CORS_ORIGIN ?? 'https://okrs-front-deploy.vercel.app')
  .split(',')
  .map(o => o.trim());

const corsOptions = {
  origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS: origem não permitida'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Headers de segurança
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cookieParser());
app.use(express.json());

// ── Saúde ────────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({ message: "API funcionando" }));

// ── Auth (público) ───────────────────────────────────────────────────────────
app.use("/auth", authRouter);

// ── Rotas protegidas ─────────────────────────────────────────────────────────
// Financeiro: GET leitura (USER restrito à sua loja) | POST/batch exige ADMIN_2+
app.use(
  "/consulta",
  authenticateToken,
  requireLojaAccess,   // restringe USER ao próprio CNPJ
  blocoFinanceiroRouter
);
app.use(
  "/financeiro",
  authenticateToken,
  requireLojaAccess,
  blocoFinanceiroRouter
);

// Operacional: mesmas regras
app.use(
  "/operacional",
  authenticateToken,
  requireLojaAccess,
  blocoOperacionalRouter
);

// Geral (todas as lojas — ADMIN_3+): restrição aplicada no router
app.use("/geral", blocoGeralRouter);

// ── Debug (mantido apenas em dev) ───────────────────────────────────────────
app.get("/debug/ordens", authenticateToken, requireLevel("ADMIN_1"), async (req, res) => {
  const { cnpj, inicio, fim, page = "1" } = req.query as Record<string, string>;
  if (!cnpj || !inicio || !fim) {
    return res.status(400).json({ error: "Parâmetros obrigatórios: cnpj, inicio, fim" });
  }

  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg }     = await import("@prisma/adapter-pg");
  const adapter          = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma           = new PrismaClient({ adapter });

  try {
    const loja = await prisma.loja.findUnique({ where: { cnpj } });
    if (!loja) return res.status(404).json({ error: `Loja não encontrada: ${cnpj}` });

    const empresa = loja.codigoLicenca;
    if (!empresa) return res.status(400).json({ error: "Loja sem codigoLicenca cadastrado" });

    const paths  = [`/api/v1/integracoes/ordens-servico/periodo`];
    const tryPath = (req.query.path as string) ?? paths[0];
    const url = `${process.env.SSOTICA_BASE_URL}${tryPath}?empresa=${empresa}&inicio_periodo=${inicio}&fim_periodo=${fim}&perPage=50&page=${page}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SSOTICA_TOKEN}` },
    });

    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }

    return res.status(response.status).json({
      _debug: { empresa, cnpj, url: url.replace(process.env.SSOTICA_TOKEN!, "***"), status: response.status },
      data: json,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  } finally {
    await prisma.$disconnect();
  }
});

// ── Start (local dev) ────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3333;
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}

// Vercel serverless: exporta o app como default
export default app;
