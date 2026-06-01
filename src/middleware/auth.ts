import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

export const LEVEL: Record<string, number> = {
  // Valores novos
  LOJA:           0,
  GERENTE:        1,
  DIRECAO:        2,
  ADMINISTRATIVO: 3,
  TI:             4,
  // Aliases legados — suporte a tokens emitidos antes da migração
  USER:     0,
  REGIONAL: 1,
  ADMIN_3:  2,
  ADMIN_2:  3,
  ADMIN_1:  4,
};

export interface AuthUser {
  sub:       string;
  email:     string;
  type:      string;
  lojaId:    string | null;
  lojaCnpj:  string | null;
  lojaNome:  string | null;
  lojaIds:   string[];   // REGIONAL: IDs das lojas atribuídas
  lojaCnpjs: string[];   // REGIONAL: CNPJs das lojas atribuídas
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  const raw  = auth?.startsWith("Bearer ") ? auth.slice(7) : req.cookies?.okrs_token;

  if (!raw) {
    return res.status(401).json({ error: "Token não fornecido." });
  }

  try {
    const payload = jwt.verify(raw, process.env.JWT_SECRET!) as AuthUser;
    if (!payload.lojaIds)   payload.lojaIds   = [];
    if (!payload.lojaCnpjs) payload.lojaCnpjs = [];
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado." });
  }
}

export function requireLevel(minType: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userLevel = LEVEL[req.user?.type ?? "USER"] ?? 0;
    if (userLevel < (LEVEL[minType] ?? 0)) {
      return res.status(403).json({ error: "Acesso negado. Permissão insuficiente." });
    }
    next();
  };
}

export function requireLojaAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Não autenticado." });

  const { type, lojaCnpj, lojaCnpjs } = req.user;
  const level = LEVEL[type] ?? 0;

  // Nível LOJA (inclui alias legado USER): restringe ao próprio CNPJ
  if (level === LEVEL.LOJA) {
    const cnpjSolicitado = req.query.cnpj as string;
    if (lojaCnpj !== cnpjSolicitado) {
      return res.status(403).json({ error: "Acesso negado. Esta loja não está vinculada ao seu usuário." });
    }
    return next();
  }

  // Nível GERENTE (inclui alias legado REGIONAL): restringe às lojas atribuídas
  if (level === LEVEL.GERENTE) {
    const cnpjSolicitado = req.query.cnpj as string;
    if (!lojaCnpjs.includes(cnpjSolicitado)) {
      return res.status(403).json({ error: "Acesso negado. Esta loja não está na sua região." });
    }
    return next();
  }

  next(); // DIRECAO+ acessa qualquer loja
}
