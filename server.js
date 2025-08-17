require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const fetch = require('node-fetch');
const { Configuration, OpenAIApi } = require('openai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

const configuration = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
const openai = new OpenAIApi(configuration);

// --- Middleware para autenticar token JWT ---
function verifyToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.userId = decoded.id;
    next();
  });
}

// --- Registro ---
app.post('/api/register', async (req, res) => {
  const { nomeusuario, senha } = req.body;
  try {
    const [exist] = await db.query('SELECT id FROM Jogadores WHERE nomeusuario = ?', [nomeusuario]);
    if (exist.length > 0) return res.status(400).json({ error: 'Usuário já existe' });

    const hash = await bcrypt.hash(senha, 10);
    await db.query('INSERT INTO Jogadores(nomeusuario, senha) VALUES (?,?)', [nomeusuario, hash]);
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// --- Login ---
app.post('/api/login', async (req,res)=>{
  const { nomeusuario, senha } = req.body;
  try{
    const [rows] = await db.query('SELECT * FROM Jogadores WHERE nomeusuario=?', [nomeusuario]);
    if(rows.length===0) return res.status(400).json({ error:'Usuário não existe' });

    const jogador = rows[0];
    const match = await bcrypt.compare(senha, jogador.senha);
    if(!match) return res.status(400).json({ error:'Senha incorreta' });

    const token = jwt.sign({ id:jogador.id }, process.env.JWT_SECRET, { expiresIn: process.env.TOKEN_EXPIRES_IN });
    res.json({ token, id:jogador.id, nomeusuario: jogador.nomeusuario, pontos:jogador.pontos });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// --- Ranking ---
app.get('/api/ranking', async (req,res)=>{
  try{
    const [rows] = await db.query('SELECT nomeusuario,pontos FROM Jogadores ORDER BY pontos DESC LIMIT 10');
    res.json(rows);
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// --- Adicionar pontos ---
app.post('/api/addpoints', verifyToken, async(req,res)=>{
  const { pontos } = req.body;
  try{
    await db.query('UPDATE Jogadores SET pontos = pontos + ? WHERE id = ?', [pontos, req.userId]);
    res.json({ success:true });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// --- Fase da semana (NewsAPI + OpenAI) ---
app.get('/api/fase', verifyToken, async(req,res)=>{
  try{
    const newsRes = await fetch(`https://newsapi.org/v2/top-headlines?category=science&q=environment&apiKey=${process.env.NEWS_API_KEY}`);
    const newsData = await newsRes.json();
    const noticia = newsData.articles[0];

    // Gera 3 perguntas automáticas via OpenAI
    const prompt = `
      Gere 3 perguntas de múltipla escolha (A,B,C,D) sobre esta notícia:
      Título: ${noticia.title}
      Conteúdo: ${noticia.description || noticia.content}
      Retorne em JSON: [{ "q": "...", "a":"...", "b":"...", "c":"...", "d":"...", "resposta":"A" }, ...]
    `;
    const aiRes = await openai.createChatCompletion({
      model:'gpt-4',
      messages:[{role:'user', content: prompt}],
      max_tokens:500
    });
    const perguntas = JSON.parse(aiRes.data.choices[0].message.content);

    res.json({
      problema: { titulo: noticia.title, descricao: noticia.description || noticia.content },
      perguntas,
      explicacao: `Exemplo: criar um programa em Python que trate o problema acima.`
    });

  } catch(e){
    console.error(e);
    res.status(500).json({error:'Erro ao gerar fase'});
  }
});

// --- Submissão de quiz ---
app.post('/api/quiz', verifyToken, async(req,res)=>{
  const { perguntaIndex, resposta } = req.body;
  // Para simplificar, vamos assumir que a resposta correta vem do frontend
  let pontos = (resposta === 'correta') ? 10 : 0;
  try{
    await db.query('UPDATE Jogadores SET pontos = pontos + ? WHERE id = ?', [pontos, req.userId]);
    res.json({ pontos });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

// --- Submissão de código Python ---
app.post('/api/code', verifyToken, async(req,res)=>{
  const { codigo } = req.body;
  // Aqui você pode validar/executar o código em sandbox seguro
  let certo = true; // simplificado
  let pontos = certo ? 50 : 0;
  try{
    await db.query('UPDATE Jogadores SET pontos = pontos + ? WHERE id = ?', [pontos, req.userId]);
    res.json({ certo, pontos });
  } catch(e){ res.status(500).json({ error:e.message }); }
});

app.listen(process.env.PORT, ()=> console.log(`Server rodando na porta ${process.env.PORT}`));
