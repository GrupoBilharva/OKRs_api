import "dotenv/config";
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { authenticateToken, requireLevel } from "../middleware/auth";

// Rate limit in-memory para /auth/login (15 min / 10 tentativas por IP)
// Aviso: em Vercel serverless o contador não persiste entre instâncias diferentes.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';

  const now   = Date.now();
  const entry = loginAttempts.get(ip);

  if (entry && entry.resetAt > now && entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  }

  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count++;
  }

  next();
}

const router = Router();

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma  = new PrismaClient({ adapter });

const LOJA_SELECT = { id: true, name: true, cnpj: true, cidade: true, sigla: true } as const;

const INCLUDE_LOJAS_REGIONAIS = {
  loja: { select: LOJA_SELECT },
  lojasRegionais: {
    include: { loja: { select: LOJA_SELECT } },
  },
  regiao: {
    include: {
      lojas: { include: { loja: { select: LOJA_SELECT } } },
    },
  },
};

function formatUser(u: any) {
  const lojas = u.regiao
    ? u.regiao.lojas.map((rl: any) => rl.loja)
    : (u.lojasRegionais ?? []).map((ul: any) => ul.loja);

  return {
    id:     u.id,
    name:   u.name,
    email:  u.email,
    type:   u.type,
    loja:   u.loja ?? null,
    lojas,
    regiao: u.regiao ? { id: u.regiao.id, nome: u.regiao.nome } : null,
  };
}

function formatRegiao(r: any) {
  return {
    id:    r.id,
    nome:  r.nome,
    lojas: r.lojas.map((rl: any) => rl.loja),
  };
}

// ─── POST /auth/login ───────────────────────────────────────────────────────
router.post("/login", loginRateLimit, async (req, res) => {
  const schema = z.object({
    email:    z.string().email(),
    password: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Email e senha são obrigatórios." });

  const { email, password } = parsed.data;

  try {
    const user = await prisma.user.findUnique({
      where:   { email },
      include: INCLUDE_LOJAS_REGIONAIS,
    });

    if (!user) return res.status(401).json({ error: "Email ou senha incorretos." });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Email ou senha incorretos." });

    // Usa região se atribuída, senão usa lojas diretas (mesmo critério do formatUser)
    const lojasDoToken = user.regiao
      ? user.regiao.lojas.map((rl: any) => rl.loja)
      : user.lojasRegionais.map((ul: any) => ul.loja);

    const lojaIds   = lojasDoToken.map((l: any) => l.id);
    const lojaCnpjs = lojasDoToken.map((l: any) => l.cnpj);

    const token = jwt.sign(
      {
        sub:       user.id,
        email:     user.email,
        type:      user.type,
        lojaId:    user.lojaId        ?? null,
        lojaCnpj:  user.loja?.cnpj    ?? null,
        lojaNome:  user.loja?.name    ?? null,
        lojaIds,
        lojaCnpjs,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "8h" }
    );

    // Log login (non-blocking)
    void prisma.userEvent.create({
      data: {
        userId: user.id,
        action: 'LOGIN',
        payload: {
          userType:  user.type,
          lojaId:    user.lojaId    ?? null,
          lojaNome:  user.loja?.name ?? null,
          lojaCnpj:  user.loja?.cnpj ?? null,
        },
      },
    }).catch(() => {});

    res.cookie('okrs_token', token, {
      httpOnly: true,
      secure:   true,
      sameSite: 'none',
      maxAge:   8 * 60 * 60 * 1000,
    });
    return res.json({ user: formatUser(user) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /auth/logout ──────────────────────────────────────────────────────
router.post("/logout", (_req, res) => {
  res.clearCookie('okrs_token', { httpOnly: true, secure: true, sameSite: 'none' });
  return res.status(204).send();
});

// ─── GET /auth/me ───────────────────────────────────────────────────────────
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:   { id: req.user!.sub },
      include: INCLUDE_LOJAS_REGIONAIS,
    });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
    return res.json(formatUser(user));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /auth/lojas  (DIRECAO+) ───────────────────────────────────────────
router.get("/lojas", authenticateToken, requireLevel("DIRECAO"), async (_req, res) => {
  try {
    const lojas = await prisma.loja.findMany({
      select:  { id: true, name: true, cnpj: true, cidade: true, sigla: true },
      orderBy: [{ name: "asc" }, { cidade: "asc" }],
    });
    return res.json(lojas);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /auth/users  (TI) ─────────────────────────────────────────────────
router.get("/users", authenticateToken, requireLevel("TI"), async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: INCLUDE_LOJAS_REGIONAIS,
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });
    return res.json(users.map(formatUser));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /auth/users  (TI) ────────────────────────────────────────────────
router.post("/users", authenticateToken, requireLevel("TI"), async (req, res) => {
  const schema = z.object({
    name:      z.string().min(2),
    email:     z.string().email(),
    password:  z.string().min(6),
    type:      z.enum(["LOJA", "GERENTE", "DIRECAO", "ADMINISTRATIVO", "TI"]),
    lojaId:    z.string().uuid().optional().nullable(),
    lojaIds:   z.array(z.string().uuid()).optional(),
    regiaoId:  z.string().uuid().optional().nullable(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, email, password, type, lojaId, lojaIds, regiaoId } = parsed.data;

  if (type === "LOJA" && !lojaId) {
    return res.status(400).json({ error: "Usuários do tipo Loja precisam ter uma loja vinculada." });
  }
  if (type === "GERENTE" && !regiaoId && (!lojaIds || lojaIds.length === 0)) {
    return res.status(400).json({ error: "Gerentes precisam ter uma região ou lojas atribuídas." });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashed,
        type,
        lojaId:   lojaId   ?? null,
        regiaoId: regiaoId ?? null,
        ...(type === "GERENTE" && !regiaoId && lojaIds
          ? { lojasRegionais: { create: lojaIds.map((id) => ({ lojaId: id })) } }
          : {}),
      },
      include: INCLUDE_LOJAS_REGIONAIS,
    });

    return res.status(201).json(formatUser(user));
  } catch (err: any) {
    if (err.code === "P2002") return res.status(409).json({ error: "Email já cadastrado." });
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /auth/users/:id  (TI) ───────────────────────────────────────────
router.patch("/users/:id", authenticateToken, requireLevel("TI"), async (req, res) => {
  const schema = z.object({
    name:      z.string().min(2).optional(),
    password:  z.string().min(6).optional(),
    type:      z.enum(["LOJA", "GERENTE", "DIRECAO", "ADMINISTRATIVO", "TI"]).optional(),
    lojaId:    z.string().uuid().nullable().optional(),
    lojaIds:   z.array(z.string().uuid()).optional(),
    regiaoId:  z.string().uuid().nullable().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, password, type, lojaId, lojaIds, regiaoId } = parsed.data;
  const userId = req.params.id as string;

  const updateData: Record<string, any> = {};
  if (name     !== undefined) updateData.name     = name;
  if (type     !== undefined) updateData.type     = type;
  if (lojaId   !== undefined) updateData.lojaId   = lojaId;
  if (regiaoId !== undefined) updateData.regiaoId = regiaoId;
  if (password !== undefined) updateData.password = await bcrypt.hash(password, 10);

  try {
    if (lojaIds !== undefined) {
      // substitui todas as lojas regionais diretas (sem região)
      await prisma.$transaction([
        prisma.userLoja.deleteMany({ where: { userId } }),
        ...(lojaIds.length > 0
          ? [prisma.userLoja.createMany({ data: lojaIds.map((id) => ({ userId, lojaId: id })) })]
          : []),
      ]);
    }
    // Se trocou para região, limpa atribuições diretas antigas
    if (regiaoId !== undefined && regiaoId !== null) {
      await prisma.userLoja.deleteMany({ where: { userId } });
    }

    const user = await prisma.user.update({
      where:   { id: userId },
      data:    updateData,
      include: INCLUDE_LOJAS_REGIONAIS,
    });

    return res.json(formatUser(user));
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Usuário não encontrado." });
    return res.status(500).json({ error: err.message });
  }
});

// ─── PUT /auth/users/:id/lojas  (TI) — redefine lojas do gerente ───────────
router.put("/users/:id/lojas", authenticateToken, requireLevel("TI"), async (req, res) => {
  const schema = z.object({ lojaIds: z.array(z.string().uuid()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId  = req.params.id as string;
  const { lojaIds } = parsed.data;

  try {
    await prisma.$transaction([
      prisma.userLoja.deleteMany({ where: { userId } }),
      prisma.userLoja.createMany({ data: lojaIds.map((id) => ({ userId, lojaId: id })) }),
    ]);

    const user = await prisma.user.findUnique({ where: { id: userId }, include: INCLUDE_LOJAS_REGIONAIS });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    return res.json(formatUser(user));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /auth/regioes  (DIRECAO+) ──────────────────────────────────────────
router.get("/regioes", authenticateToken, requireLevel("DIRECAO"), async (_req, res) => {
  try {
    const regioes = await prisma.regiao.findMany({
      include: { lojas: { include: { loja: { select: LOJA_SELECT } } } },
      orderBy: { nome: "asc" },
    });
    return res.json(regioes.map(formatRegiao));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /auth/regioes  (TI) ───────────────────────────────────────────────
router.post("/regioes", authenticateToken, requireLevel("TI"), async (req, res) => {
  const schema = z.object({
    nome:    z.string().min(2),
    lojaIds: z.array(z.string().uuid()).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { nome, lojaIds } = parsed.data;
  try {
    const regiao = await prisma.regiao.create({
      data: {
        nome,
        lojas: { create: lojaIds.map((id) => ({ lojaId: id })) },
      },
      include: { lojas: { include: { loja: { select: LOJA_SELECT } } } },
    });
    return res.status(201).json(formatRegiao(regiao));
  } catch (err: any) {
    if (err.code === "P2002") return res.status(409).json({ error: "Já existe uma região com esse nome." });
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /auth/regioes/:id  (TI) ──────────────────────────────────────────
router.patch("/regioes/:id", authenticateToken, requireLevel("TI"), async (req, res) => {
  const schema = z.object({
    nome:    z.string().min(2).optional(),
    lojaIds: z.array(z.string().uuid()).min(1).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { nome, lojaIds } = parsed.data;
  const id = req.params.id as string;

  try {
    if (lojaIds !== undefined) {
      await prisma.$transaction([
        prisma.regiaoLoja.deleteMany({ where: { regiaoId: id } }),
        prisma.regiaoLoja.createMany({ data: lojaIds.map((lojaId) => ({ regiaoId: id, lojaId })) }),
      ]);
    }
    const regiao = await prisma.regiao.update({
      where:   { id },
      data:    nome ? { nome } : {},
      include: { lojas: { include: { loja: { select: LOJA_SELECT } } } },
    });
    return res.json(formatRegiao(regiao));
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Região não encontrada." });
    if (err.code === "P2002") return res.status(409).json({ error: "Já existe uma região com esse nome." });
    return res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /auth/regioes/:id  (TI) ─────────────────────────────────────────
router.delete("/regioes/:id", authenticateToken, requireLevel("TI"), async (req, res) => {
  try {
    await prisma.regiao.delete({ where: { id: req.params.id as string } });
    return res.status(204).send();
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Região não encontrada." });
    return res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /auth/users/:id  (TI) ───────────────────────────────────────────
router.delete("/users/:id", authenticateToken, requireLevel("TI"), async (req, res) => {
  if (req.user!.sub === req.params.id) {
    return res.status(400).json({ error: "Você não pode excluir o próprio usuário." });
  }

  try {
    await prisma.user.delete({ where: { id: req.params.id as string } });
    return res.status(204).send();
  } catch (err: any) {
    if (err.code === "P2025") return res.status(404).json({ error: "Usuário não encontrado." });
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /auth/analytics  (TI) ─────────────────────────────────────────────
router.get("/analytics", authenticateToken, requireLevel("TI"), async (_req, res) => {
  try {
    const seteAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [loginsPorDia, rankingLojas, recentesMetas, ativosHojeRes, metaEdits7d] = await Promise.all([
      prisma.$queryRaw<{ data: string; total: number }[]>`
        SELECT TO_CHAR("createdAt", 'YYYY-MM-DD') as data, COUNT(*)::int as total
        FROM "UserEvent"
        WHERE action = 'LOGIN' AND "createdAt" >= ${seteAtras}
        GROUP BY TO_CHAR("createdAt", 'YYYY-MM-DD')
        ORDER BY data ASC
      `,
      prisma.$queryRaw<{ lojaNome: string; cnpj: string; cidade: string | null; acessos: number }[]>`
        SELECT
          ue.payload->>'lojaNome' AS "lojaNome",
          ue.payload->>'lojaCnpj' AS cnpj,
          l.cidade,
          COUNT(*)::int AS acessos
        FROM "UserEvent" ue
        LEFT JOIN "Loja" l ON l.cnpj = ue.payload->>'lojaCnpj'
        WHERE ue.action = 'LOGIN'
          AND ue."createdAt" >= ${seteAtras}
          AND ue.payload->>'lojaCnpj' IS NOT NULL
        GROUP BY ue.payload->>'lojaNome', ue.payload->>'lojaCnpj', l.cidade
        ORDER BY acessos DESC
        LIMIT 10
      `,
      prisma.userEvent.findMany({
        where:   { action: 'META_EDIT' },
        orderBy: { createdAt: 'desc' },
        take:    15,
        include: { user: { select: { name: true } } },
      }),
      prisma.$queryRaw<{ total: number }[]>`
        SELECT COUNT(DISTINCT "userId")::int as total FROM "UserEvent"
        WHERE action = 'LOGIN' AND "createdAt" >= CURRENT_DATE
      `,
      prisma.userEvent.count({ where: { action: 'META_EDIT', createdAt: { gte: seteAtras } } }),
    ]);

    return res.json({
      loginsPorDia,
      rankingLojas,
      recentesMetas: recentesMetas.map(e => ({
        id:        e.id,
        userName:  e.user.name,
        createdAt: e.createdAt,
        payload:   e.payload,
      })),
      ativosHoje:    ativosHojeRes[0]?.total ?? 0,
      totalLogins7d: loginsPorDia.reduce((a, d) => a + d.total, 0),
      metaEdits7d,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
