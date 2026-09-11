/**
 * ============================================================================
 *  LARIZINHA STORE — BOT ADMINISTRATIVO
 * ----------------------------------------------------------------------------
 *  Arquivo principal do bot de administração.
 *
 *  Responsabilidades:
 *   - Iniciar o bot do Telegram (Telegraf)
 *   - Autenticar administradores (verificação real no banco)
 *   - Aplicar anti-flood configurável
 *   - Respeitar modo manutenção (mas permitir admins)
 *   - Renderizar menu principal (Dashboard)
 *   - Delegar para módulos de menu (dashboard, config, etc.)
 *
 *  REGRA DE OURO:
 *   NUNCA enviar nova mensagem durante navegação.
 *   Sempre usar editMessageText / editMessageMedia / editMessageReplyMarkup.
 *
 *  Bot Admin Token:
 *   8464485123:AAGfibOpvx6ASRrcepmQJlZ1GuoAAYml6Ws
 * ============================================================================
 */

'use strict';

require('dotenv').config();

const { Telegraf, Markup, session } = require('telegraf');
const Redis = require('ioredis');
const moment = require('moment-timezone');
const winston = require('winston');

// ─── Models / Config ────────────────────────────────────────────────────────
const { sequelize } = require('../config/database');
const {
  User,
  Admin,
  BotConfig,
  MaintenanceMode,
  AntiFlood,
  Log,
} = require('../models');

// ─── Menus (módulos) ────────────────────────────────────────────────────────
const { renderDashboard, handleDashboardActions } = require('./menus/dashboard');
const { renderConfiguracoes, handleConfiguracoesActions } = require('./menus/configuracoes');
const { renderAcoes, handleAcoesActions } = require('./menus/acoes');
const { renderTransacoes, handleTransacoesActions } = require('./menus/transacoes');
const { renderAtualizacoes, handleAtualizacoesActions } = require('./menus/atualizacoes');

// ─── Utilitários ────────────────────────────────────────────────────────────
const { safeEdit, safeEditMedia } = require('../utils/safeEdit');
const { isAdmin, requireAdmin, requireOwner } = require('../middlewares/auth');
const { antiFlood } = require('../middlewares/antiFlood');
const { maintenanceGuard } = require('../middlewares/maintenance');
const { logAction } = require('../utils/logger');
const { tz } = require('../config/constants');

// ─── Logger ─────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: () => moment().tz(tz).format('YYYY-MM-DD HH:mm:ss') }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] [ADMIN-BOT] [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/admin-bot-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/admin-bot.log' }),
  ],
});

// ─── Bot Instance ───────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.ADMIN_BOT_TOKEN);

// ─── Redis (sessão) ─────────────────────────────────────────────────────────
const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB_ADMIN || '1', 10),
  lazyConnect: false,
});

redis.on('error', (err) => logger.error(`Redis error: ${err.message}`));
redis.on('connect', () => logger.info('Redis conectado (admin-bot).'));

// ─── Session middleware ─────────────────────────────────────────────────────
bot.use(
  session({
    store: {
      get: async (key) => {
        const data = await redis.get(key);
        return data ? JSON.parse(data) : undefined;
      },
      set: async (key, value) => {
        await redis.set(key, JSON.stringify(value), 'EX', 3600);
      },
      delete: async (key) => {
        await redis.del(key);
      },
    },
    defaultSession: () => ({}),
  })
);

// ─── Middlewares globais ────────────────────────────────────────────────────
bot.use(antiFlood);         // Anti-flood configurável
bot.use(maintenanceGuard);  // Bloqueia uso durante manutenção (exceto admins)

// ─── Comando /start ─────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();

  // Verifica se é admin
  const admin = await isAdmin(userId);
  if (!admin) {
    return ctx.reply(
      '🚫 Você não tem permissão para acessar este bot.',
      Markup.removeKeyboard()
    );
  }

  // Registra o último acesso
  await Admin.update(
    { last_access: new Date() },
    { where: { telegram_id: userId } }
  );

  await logAction(userId, 'ACESSOU_PAINEL', `Admin ${ctx.from.username || userId} acessou o painel`);

  // Renderiza dashboard (ou envia nova mensagem se for /start)
  await renderDashboard(ctx, { edit: false });
});

// ─── Comando /admin (atalho) ────────────────────────────────────────────────
bot.command('admin', async (ctx) => {
  const userId = ctx.from.id.toString();
  const admin = await isAdmin(userId);
  if (!admin) return;

  await renderDashboard(ctx, { edit: false });
});

// ─── Comando /help ──────────────────────────────────────────────────────────
bot.command('help', async (ctx) => {
  const userId = ctx.from.id.toString();
  const admin = await isAdmin(userId);
  if (!admin) return;

  const helpText = `
🛠️ <b>PAINEL ADMIN — AJUDA</b>

Use os botões do dashboard para navegar.
Todos os menus usam <b>mensagem única</b> (nada acumula).

🔹 <b>Comandos disponíveis:</b>
/start — Abre o painel
/admin — Atalho para o painel
/help — Esta mensagem
/id — Mostra seu ID e ID do chat

🔹 <b>Suporte a variáveis nas mensagens:</b>
{USER_ID} {USERNAME} {BALANCE} {PRODUCT_NAME}
{PRODUCT_PRICE} {STOCK} {ORDER_ID} {DATE} {BONUS}

🔹 <b>Status:</b>
Último acesso: ${moment().tz(tz).format('DD/MM/YYYY HH:mm:ss')}
  `.trim();

  await ctx.replyWithHTML(helpText);
});

// ─── Comando /id ────────────────────────────────────────────────────────────
bot.command('id', async (ctx) => {
  const userId = ctx.from.id.toString();
  const admin = await isAdmin(userId);
  if (!admin) return;

  await ctx.replyWithHTML(
    `🆔 <b>Seu ID:</b> <code>${userId}</code>\n` +
    `💬 <b>ID do chat:</b> <code>${ctx.chat.id}</code>`
  );
});

// ─── Callback Router ────────────────────────────────────────────────────────
// Todos os botões têm prefixo. Roteamos pelo prefixo para o módulo correto.
// Padrão: "<módulo>:<ação>:<params>"
// Ex: "dash:refresh", "conf:gerais", "conf:pix:mudar_token"
// ────────────────────────────────────────────────────────────────────────────
bot.on('callback_query', async (ctx) => {
  const userId = ctx.from.id.toString();
  const admin = await isAdmin(userId);
  if (!admin) {
    return ctx.answerCbQuery('🚫 Sem permissão.', { show_alert: true });
  }

  const data = ctx.callbackQuery.data || '';
  const [module] = data.split(':');

  try {
    switch (module) {
      case 'dash':
        await handleDashboardActions(ctx, admin);
        break;

      case 'conf':
        await handleConfiguracoesActions(ctx, admin);
        break;

      case 'acoes':
        await handleAcoesActions(ctx, admin);
        break;

      case 'trans':
        await handleTransacoesActions(ctx, admin);
        break;

      case 'upd':
        await handleAtualizacoesActions(ctx, admin);
        break;

      case 'noop':
        await ctx.answerCbQuery();
        break;

      default:
        logger.warn(`Callback desconhecido: ${data}`);
        await ctx.answerCbQuery('⚠️ Ação não reconhecida.');
    }
  } catch (err) {
    logger.error(`Erro em callback (${data}): ${err.message}\n${err.stack}`);
    try {
      await ctx.answerCbQuery('❌ Erro ao processar ação.', { show_alert: true });
    } catch (_) {}
  }
});

// ─── Mensagens de texto genéricas ───────────────────────────────────────────
// Aqui entram fluxos que pedem input do admin (ex: "Envie o novo valor do token PIX")
// Utilizamos session.step para controlar em que etapa o admin está.
// Os módulos (configuracoes.js, etc.) populam ctx.session.step.
// ────────────────────────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const admin = await isAdmin(userId);
  if (!admin) return;

  const step = ctx.session?.step;
  if (!step) {
    // Sem passo ativo: ignora ou mostra dica
    return;
  }

  // Delega para o handler registrado no session
  try {
    const handler = require(`./steps/${step}`);
    await handler(ctx, admin);
    ctx.session.step = null;
  } catch (err) {
    logger.error(`Erro no step "${step}": ${err.message}`);
    ctx.session.step = null;
    await ctx.reply('❌ Ocorreu um erro ao processar esse passo. Tente novamente.');
  }
});

// ─── Tratamento de erros ────────────────────────────────────────────────────
bot.catch(async (err, ctx) => {
  logger.error(`Erro no bot admin: ${err.message}\n${err.stack}`);
  try {
    if (ctx?.reply) {
      await ctx.reply('❌ Ocorreu um erro inesperado. Tente novamente.');
    }
  } catch (_) {}
});

// ─── Inicialização ──────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    logger.info('Conectando ao banco de dados...');
    await sequelize.authenticate();
    logger.info('Banco de dados conectado.');

    logger.info('Conectando ao Redis...');
    await redis.ping();
    logger.info('Redis OK.');

    // Verifica se há algum admin cadastrado; se não, cria o owner
    const ownerId = process.env.OWNER_TELEGRAM_ID;
    if (ownerId) {
      const existing = await Admin.findOne({ where: { telegram_id: ownerId } });
      if (!existing) {
        await Admin.create({
          telegram_id: ownerId,
          role: 'owner',
          added_by: 'system',
          permissions: 'all',
        });
        logger.info(`Owner criado: ${ownerId}`);
      }
    }

    // Sobe o bot em modo polling (ou webhook se configurado)
    const useWebhook = process.env.ADMIN_USE_WEBHOOK === 'true';
    if (useWebhook) {
      const domain = process.env.ADMIN_WEBHOOK_DOMAIN;
      const port = parseInt(process.env.ADMIN_WEBHOOK_PORT || '3001', 10);
      const secret = process.env.ADMIN_WEBHOOK_SECRET || undefined;

      await bot.telegram.setWebhook(`${domain}/admin/${secret}`);
      bot.startWebhook(`/admin/${secret}`, null, port);
      logger.info(`Webhook admin ativo em ${domain}/admin/*** (porta ${port})`);
    } else {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      await bot.launch();
      logger.info('Bot ADMIN rodando em modo polling.');
    }

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`Sinal ${signal} recebido. Encerrando...`);
      try {
        bot.stop(signal);
      } catch (_) {}
      try {
        await redis.quit();
      } catch (_) {}
      try {
        await sequelize.close();
      } catch (_) {}
      process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    logger.error(`Falha ao iniciar: ${err.message}\n${err.stack}`);
    process.exit(1);
  }
}

// ─── Executa ────────────────────────────────────────────────────────────────
if (require.main === module) {
  bootstrap();
}

module.exports = { bot, bootstrap };
