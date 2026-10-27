# GlicoCare · API Node.js

API REST em Node.js para contas, acompanhamento compartilhado, registros de glicose, aplicações, ocorrências de consumo de algo doce, resumos mensais, PDF e lembretes. Usa PostgreSQL, migrações SQL versionadas, sessão assinada em cookie HttpOnly, autorização por vínculo e auditoria de operações.

## Desenvolvimento local

1. Instale Node.js 20+ e PostgreSQL 15+.
2. Copie `.env.example` para `.env` e defina `DATABASE_URL`, `DATABASE_SSL=false`, um `JWT_SECRET` aleatório com ao menos 32 bytes e `FRONTEND_URL=http://localhost:5173`.
3. Crie o banco `glicocare` ou atualize a URL para um banco de desenvolvimento vazio.
4. Execute `npm install`, `npm run db:migrate` e `npm run dev`.
5. A API local fica em `http://localhost:3001`; a interface Vite encaminha `/api` para ela.

Não use dados reais de saúde em desenvolvimento. A aplicação não popula registros fictícios automaticamente.

## Variáveis de ambiente

| Variável | Finalidade |
| --- | --- |
| `DATABASE_URL` | URL de conexão PostgreSQL. Nunca exponha no frontend. |
| `DATABASE_SSL` | Defina `false` somente para PostgreSQL local. Em produção, mantenha TLS. |
| `JWT_SECRET` | Segredo aleatório para assinar sessões; mínimo 32 bytes. |
| `FRONTEND_URL` | Origem exata da interface, usada no CORS, CSRF e links de e-mail. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Envio de convites e recuperação de senha. O endereço remetente precisa estar verificado no Resend. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Chaves Web Push. Gere um par VAPID e mantenha a privada somente no backend. |
| `CRON_SECRET` | Segredo Bearer para proteger `/api/jobs/reminders`. |
| `DEFAULT_TIMEZONE` | Fuso IANA no cadastro; padrão `America/Sao_Paulo`. |

## Migrações

`npm run db:migrate` aplica arquivos SQL em ordem e registra cada migração em `schema_migrations`. Faça backup antes de mudanças em um banco de produção. A migração inicial cria usuários, pacientes, vínculos, convites, dados normalizados, lembretes, assinaturas push, entregas, auditoria, recuperação de senha e controle de tentativas.

## API

`GET /api/openapi.json` publica a especificação OpenAPI. `GET /api/health` verifica o serviço e informa somente se a variável de banco existe; não valida conectividade nem revela credenciais.

Rotas principais: `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/me`, `/auth/password/forgot`, `/auth/password/reset`, `/patients/current`, `/records`, `/records/:id`, `/reports/month`, `/reports/month/pdf`, `/sharing`, `/invites`, `/invites/accept`, `/reminders`, `/push/subscriptions` e `/jobs/reminders`.

Todas as operações de saúde exigem sessão e vínculo ativo no servidor. Uma conta pode ser responsável por um acompanhamento e aceitar convite para outro. Cada paciente aceita um responsável principal e até uma pessoa cuidadora. Senhas são armazenadas com bcrypt; tokens de convite e recuperação são guardados como hash e têm uso único/expiração. Valores ausentes permanecem `NULL`; aplicação pendente não possui dose nem horário de aplicação.

## Vercel

Crie um projeto Vercel conectado a este repositório, com diretório raiz do repositório. O handler Node.js está em `api/[...path].js`. O `vercel.json` padrão não registra cron para continuar publicável em contas Hobby. Configure as variáveis acima no projeto e execute `npm run db:migrate` contra a base de produção antes de ativar tráfego.

O endpoint de agendamento só envia notificações se `DATABASE_URL`, `CRON_SECRET`, `VAPID_*` e assinaturas válidas estiverem configurados. Ele é autenticado com `Authorization: Bearer <CRON_SECRET>`. A chave por lembrete/data evita envio duplicado no mesmo dia; cada dispositivo possui estado de entrega e até três tentativas com intervalo controlado para falhas transitórias. Assinaturas inválidas são revogadas e ocorrências atrasadas no mesmo dia podem ser recuperadas.

O arquivo opcional `vercel.pro.json` registra execução a cada minuto, necessária para respeitar horários locais distintos; use seu conteúdo no `vercel.json` somente em plano Pro/Enterprise ou conecte um agendador externo com intervalo por minuto. A Vercel Hobby limita cron a uma execução diária e rejeita expressões mais frequentes. Verifique [limites e preços da Vercel](https://vercel.com/docs/cron-jobs/usage-and-pricing) antes de ativar lembretes em produção. O provedor PostgreSQL é escolhido pela equipe; no Marketplace da Vercel há opções como Neon e Supabase, com faturamento e limites próprios. Confira os preços do [Marketplace da Vercel](https://vercel.com/marketplace) e do serviço de e-mail escolhido antes de provisionar recursos.

## Privacidade, retenção e limitações

- Registros e e-mails são dados sensíveis; proteja o acesso à conta PostgreSQL, limite operadores e configure backups criptografados e restauração do provedor.
- Auditoria guarda usuário, operação, recurso e nomes de campos alterados; não replica valores clínicos.
- A exclusão de um registro remove os dados associados em cascata e mantém o evento de auditoria. Uma política de retenção/exclusão de contas precisa ser formalizada antes de uso real.
- O rate limit é persistido no PostgreSQL, mas a limpeza periódica da tabela `rate_limits` deve ser adicionada à rotina operacional.
- As tentativas e estados de entrega estão no banco; ainda não há uma tela administrativa de diagnóstico nem monitoramento externo de alertas.
- O código não declara conformidade legal. Requisitos LGPD, avaliação de impacto, contratos de operadores, retenção, consentimento e resposta a incidentes precisam de avaliação própria.
- Não existe cálculo, sugestão de dose, diagnóstico ou faixa clínica automática.

## Testes

Execute `npm test`. Os testes atuais cobrem conversões de fuso, limites mensais, valores ausentes e aplicação pendente. A cobertura de integração exige uma base de teste PostgreSQL isolada e ainda não está configurada neste repositório.
