// Carregado antes de qualquer teste (bunfig.toml). Os testes usam um banco próprio, para não
// disputar pendentes e eventos com o servidor de desenvolvimento rodando ao lado.
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/wagering_test';
process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
process.env.AWS_REGION ??= 'us-east-1';
