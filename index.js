require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');
const morgan = require('morgan');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { body, query, validationResult } = require('express-validator');

const api = axios.create({
  timeout: 10000,
  validateStatus: () => true,
});

// Request Logger
api.interceptors.request.use((config) => {
  config.metadata = {
    startTime: Date.now(),
  };

  const fullUrl = axios.getUri(config);

  console.log('\n================ NETWORX REQUEST ================');
  console.log('Method :', config.method?.toUpperCase());
  console.log('URL    :', fullUrl);
  console.log('BaseURL:', config.baseURL);
  console.log('Params :', config.params);
  console.log('Headers:', config.headers);
  console.log('===============================================\n');

  return config;
});

// Response Logger
api.interceptors.response.use(
  (response) => {
    const duration =
      Date.now() - (response.config.metadata?.startTime || Date.now());

    console.log('\n================ NETWORX RESPONSE ===============');
    console.log('Status  :', response.status);
    console.log('Time    :', `${duration} ms`);
    console.log('URL     :', axios.getUri(response.config));
    console.log('Headers :', response.headers);
    console.log('Data    :', response.data);
    console.log('===============================================\n');

    return response;
  },
  (error) => {
    const config = error.config || {};

    const duration = Date.now() - (config.metadata?.startTime || Date.now());

    console.log('\n================ NETWORX ERROR ==================');
    console.log('Message :', error.message);
    console.log('Code    :', error.code);
    console.log('Time    :', `${duration} ms`);

    if (config) {
      console.log('URL     :', axios.getUri(config));
      console.log('Params  :', config.params);
    }

    if (error.response) {
      console.log('Status  :', error.response.status);
      console.log('Data    :', error.response.data);
    }

    console.log('===============================================\n');

    return Promise.reject(error);
  },
);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const NX_API_BASE_URL =
  process.env.NX_API_BASE_URL || 'https://api.networx.com';
const NX_ACCESS_KEY = process.env.NX_ACCESS_KEY;
const NX_USER_ID = process.env.NX_USER_ID;
const CERT_URL = process.env.CERT_URL; // TrustedForm certificate URL (required by Networx upstream)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY; // optional, protects our own routes
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!NX_ACCESS_KEY || !NX_USER_ID) {
  console.error(
    '[FATAL] NX_ACCESS_KEY and NX_USER_ID must be set in your environment (.env). Exiting.',
  );
  process.exit(1);
}

if (!CERT_URL) {
  console.warn(
    '[WARN] CERT_URL is not set. Networx will reject lead posts with "Missing Trusted Form" unless clients send a cert_url.',
  );
}

// ---------------------------------------------------------------------------
// Networx client helper
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({ ignoreAttributes: true, trimValues: true });

/**
 * Sends a request to the Networx API and normalizes the XML response to JSON.
 * nx_access_key / nx_userId are always injected server-side and can never be
 * overridden by caller-supplied params.
 */
async function networxRequest(params) {
  const cleanParams = {
    ...params,
    nx_access_key: NX_ACCESS_KEY,
    nx_userId: NX_USER_ID,
  };

  // Drop undefined/null/empty-string values so we don't send blank fields.
  Object.keys(cleanParams).forEach((key) => {
    if (
      cleanParams[key] === undefined ||
      cleanParams[key] === null ||
      cleanParams[key] === ''
    ) {
      delete cleanParams[key];
    }
  });

  const response = await api.get(NX_API_BASE_URL, {
    params: cleanParams,
    timeout: 10000,
    // Networx expects array fields as name[] / name[0], name[1]... axios does
    // this by default for arrays (repeats the key), which matches their docs.
    paramsSerializer: { indexes: null },
    validateStatus: () => true, // we handle non-2xx ourselves below
  });

  let parsed = {};
  try {
    const result = xmlParser.parse(response.data);
    parsed = result?.affiliateResponse || { raw: response.data };
  } catch (e) {
    // Networx returned something that wasn't XML (e.g. a plain-text auth
    // rejection) - surface the raw body instead of silently returning {}.
    parsed = { raw: response.data };
  }

  return { httpStatus: response.status, data: parsed };
}

// ---------------------------------------------------------------------------
// App + global middleware (security basics)
// ---------------------------------------------------------------------------

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // needed for correct rate-limiting / IPs behind a proxy (Render, Heroku, nginx, etc.)

app.use(
  helmet({
    // Default helmet CSP is "default-src 'self'", which would silently break
    // this site: it loads Google Fonts and calls a few public geo/weather
    // APIs directly from the browser. Allowlist exactly those, keep
    // everything else locked to 'self'.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Inline <style>/<script> blocks are used throughout the site -
        // 'unsafe-inline' is required unless/until those are refactored to
        // use nonces or external files.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: [
          "'self'",
          'https://ipwho.is',
          'https://ipapi.co',
          'https://api.zippopotam.us',
          'https://api.open-meteo.com',
        ],
        objectSrc: ["'none'"],
      },
    },
  }),
);
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
    methods: ['GET', 'POST'],
  }),
);
app.use(express.json({ limit: '15kb' }));
app.use(express.urlencoded({ extended: true, limit: '15kb' }));
app.use(hpp()); // strips duplicate query/body keys (HTTP Parameter Pollution)
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

// Serve the static site from ./public (index.html, contact.html, etc. must
// live inside this folder - express.static only serves files that are
// physically inside the folder you point it at).
app.use(express.static(path.join(__dirname, 'public')));

// Generic rate limit for everything under /api
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use('/api', apiLimiter);

// Tighter limit specifically on lead/call submission endpoints to deter abuse
const submissionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please slow down.' },
});

// Optional shared-secret gate for our own API (separate from Networx's key).
// Set INTERNAL_API_KEY in .env to require `x-api-key` on every /api call.
function requireInternalKey(req, res, next) {
  if (!INTERNAL_API_KEY) return next(); // feature is opt-in
  const provided = req.get('x-api-key');
  if (provided && provided === INTERNAL_API_KEY) return next();
  return res
    .status(401)
    .json({ error: 'Unauthorized: missing or invalid API key.' });
}
app.use('/api', requireInternalKey);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res
      .status(400)
      .json({ error: 'Validation failed', details: errors.array() });
  }
  next();
}

const zipcodeValidator = body('zipcode')
  .trim()
  .matches(/^\d{5}$/)
  .withMessage('zipcode must be a 5-digit US zip code');

const phoneValidator = (field, optional = false) => {
  const chain = body(field)
    .customSanitizer((v) => (typeof v === 'string' ? v.replace(/\D/g, '') : v))
    .matches(/^\d{10}$/)
    .withMessage(`${field} must be a 10-digit phone number`);
  return optional ? chain.optional({ values: 'falsy' }) : chain;
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => res.json({ status: 'ok', env: NODE_ENV }));

/**
 * POST /api/leads/ping
 * Check whether Networx wants to buy a lead before you send full details.
 */
app.post(
  '/api/leads/ping',
  submissionLimiter,
  [
    zipcodeValidator,
    body('task_id').notEmpty().withMessage('task_id is required'),
    body('tcpa_compliance_text')
      .notEmpty()
      .withMessage('tcpa_compliance_text is required'),
    body('source_id').optional().isLength({ max: 15 }),
    body('hashed_contacts').optional().isArray(),
    body('is_business').optional().isIn(['0', '1', 0, 1]),
    body('src_created_at').optional().isISO8601(),
  ],
  handleValidation,
  async (req, res, next) => {
    try {
      const {
        zipcode,
        task_id,
        tcpa_compliance_text,
        source_id,
        hashed_contacts,
        is_business,
        src_created_at,
      } = req.body;
      const { httpStatus, data } = await networxRequest({
        zipcode,
        task_id,
        tcpa_compliance_text,
        source_id,
        'hashed_contacts[]': hashed_contacts,
        is_business,
        src_created_at,
      });
      res.status(httpStatus).json(data);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/leads/post
 * Submit a full lead, either standalone or as the follow-up to a ping
 * (include the `token` you received from /api/leads/ping).
 */
app.post(
  '/api/leads/post',
  submissionLimiter,
  [
    body('f_name').trim().notEmpty(),
    body('l_name').trim().notEmpty(),
    zipcodeValidator,
    body('task_id').notEmpty(),
    phoneValidator('phone'),
    body('email').trim().isEmail().normalizeEmail(),
    body('tcpa_compliance_text').notEmpty(),
    body('cert_url').optional().trim().isURL(),
    body('token').optional().isString(),
    body('comments').optional().isString().isLength({ max: 2000 }),
    body('address').optional().isString().isLength({ max: 255 }),
    body('custom_id').optional().isString().isLength({ max: 100 }),
    body('source_id').optional().isLength({ max: 15 }),
    body('hashed_contacts').optional().isArray(),
    body('is_business').optional().isIn(['0', '1', 0, 1]),
  ],
  handleValidation,
  async (req, res, next) => {
    try {
      const {
        f_name,
        l_name,
        zipcode,
        task_id,
        phone,
        email,
        tcpa_compliance_text,
        cert_url,
        token,
        comments,
        address,
        custom_id,
        source_id,
        hashed_contacts,
        is_business,
      } = req.body;

      const { httpStatus, data } = await networxRequest({
        f_name,
        l_name,
        zipcode,
        task_id,
        phone,
        email,
        tcpa_compliance_text,
        cert_url: CERT_URL || cert_url,
        token,
        comments,
        address,
        custom_id,
        source_id,
        'hashed_contacts[]': hashed_contacts,
        is_business,
      });
      res.status(httpStatus).json(data);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/leads/ping-post
 * Convenience endpoint: pings Networx, and if a token/price comes back,
 * immediately follows up with the post using that token - all in one call
 * from your client. Keeps ping and post info identical, as Networx requires.
 */
app.post(
  '/api/leads/ping-post',
  submissionLimiter,
  [
    zipcodeValidator,
    body('task_id').notEmpty(),
    body('tcpa_compliance_text').notEmpty(),
    body('f_name').trim().notEmpty(),
    body('l_name').trim().notEmpty(),
    phoneValidator('phone'),
    body('email').trim().isEmail().normalizeEmail(),
    body('cert_url').optional().trim().isURL(),
    body('source_id').optional().isLength({ max: 15 }),
    body('hashed_contacts').optional().isArray(),
    body('is_business').optional().isIn(['0', '1', 0, 1]),
    body('comments').optional().isString().isLength({ max: 2000 }),
    body('address').optional().isString().isLength({ max: 255 }),
    body('custom_id').optional().isString().isLength({ max: 100 }),
  ],
  handleValidation,
  async (req, res, next) => {
    try {
      const {
        zipcode,
        task_id,
        tcpa_compliance_text,
        source_id,
        hashed_contacts,
        is_business,
        f_name,
        l_name,
        phone,
        email,
        cert_url,
        comments,
        address,
        custom_id,
      } = req.body;

      const pingResult = await networxRequest({
        zipcode,
        task_id,
        tcpa_compliance_text,
        source_id,
        'hashed_contacts[]': hashed_contacts,
        is_business,
      });

      const token = pingResult.data?.token;
      if (!token) {
        // Ping was rejected or errored - nothing to post.
        return res
          .status(pingResult.httpStatus)
          .json({ step: 'ping', ...pingResult.data });
      }

      const postResult = await networxRequest({
        f_name,
        l_name,
        zipcode,
        task_id,
        phone,
        email,
        tcpa_compliance_text,
        cert_url: CERT_URL || cert_url,
        token,
        comments,
        address,
        custom_id,
        source_id,
        'hashed_contacts[]': hashed_contacts,
        is_business,
      });

      res.status(postResult.httpStatus).json({
        step: 'post',
        pingPrice: pingResult.data?.price,
        ...postResult.data,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/calls/ping
 * Either task_id or network_id is required (task_id takes precedence if both given).
 */
app.post(
  '/api/calls/ping',
  submissionLimiter,
  [
    zipcodeValidator,
    body('task_id').optional().isString(),
    body('network_id').optional().isString(),
    body('is_owned')
      .isIn(['0', '1', 0, 1])
      .withMessage('is_owned must be 0 or 1'),
    body('source_id').optional().isLength({ max: 15 }),
    phoneValidator('phone', true),
    body().custom((value) => {
      if (!value.task_id && !value.network_id) {
        throw new Error('Either task_id or network_id is required');
      }
      return true;
    }),
  ],
  handleValidation,
  async (req, res, next) => {
    try {
      const { zipcode, task_id, network_id, is_owned, source_id, phone } =
        req.body;
      const { httpStatus, data } = await networxRequest({
        zipcode,
        task_id,
        network_id,
        is_owned,
        source_id,
        phone,
      });
      res.status(httpStatus).json(data);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/calls/post
 * Follow-up to a call ping. Must include the token from the ping response.
 */
app.post(
  '/api/calls/post',
  submissionLimiter,
  [
    zipcodeValidator,
    body('token').notEmpty(),
    phoneValidator('phone'),
    body('task_id').optional().isString(),
    body('network_id').optional().isString(),
    body().custom((value) => {
      if (!value.task_id && !value.network_id) {
        throw new Error('Either task_id or network_id is required');
      }
      return true;
    }),
  ],
  handleValidation,
  async (req, res, next) => {
    try {
      const { zipcode, token, phone, task_id, network_id } = req.body;
      const { httpStatus, data } = await networxRequest({
        zipcode,
        token,
        phone,
        task_id,
        network_id,
      });
      res.status(httpStatus).json(data);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/report?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 */
app.get(
  '/api/report',
  [
    query('date_from')
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage('date_from must be YYYY-MM-DD'),
    query('date_to')
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage('date_to must be YYYY-MM-DD'),
  ],
  handleValidation,
  async (req, res, next) => {
    try {
      const { date_from, date_to } = req.query;
      const { httpStatus, data } = await networxRequest({
        type: 'report',
        date_from,
        date_to,
      });
      res.status(httpStatus).json(data);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/demand
 * Returns a link to a CSV of recent bid pricing/demand per task and area.
 */
app.get('/api/demand', async (req, res, next) => {
  try {
    const { httpStatus, data } = await networxRequest({ type: 'demand' });
    res.status(httpStatus).json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/inquiry
 * Submit a contractor sign-up inquiry.
 */
app.post(
  '/api/inquiry',
  submissionLimiter,
  [
    body('name').trim().notEmpty().withMessage('Company name is required'),
    body('contact_name').trim().notEmpty(),
    phoneValidator('phone'),
    zipcodeValidator,
    body('email').trim().isEmail().normalizeEmail(),
    body('networks')
      .isArray({ min: 1 })
      .withMessage('networks must be a non-empty array of IDs'),
    body('user_comments').optional().isString().isLength({ max: 2000 }),
  ],
  handleValidation,
  async (req, res, next) => {
    try {
      const {
        name,
        contact_name,
        phone,
        zipcode,
        email,
        networks,
        user_comments,
      } = req.body;
      const { httpStatus, data } = await networxRequest({
        type: 'inquiry',
        name,
        contact_name,
        phone,
        zipcode,
        email,
        'networks[]': networks,
        user_comments,
      });
      res.status(httpStatus).json(data);
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/networks - reference list of industry IDs for the inquiry endpoint */
app.get('/api/networks', (req, res) => {
  res.json({
    'Air Ducts/Vents - Clean': 44,
    Appliances: 30,
    Asphalt: 31,
    'Bathroom Remodeling': 50,
    Carpenters: 20,
    'Carpet Cleaning': 27,
    'Carpet Flooring': 2,
    Cleaning: 11,
    Concrete: 18,
    'Concrete Foundation': 38,
    Countertops: 36,
    'Deck Building': 48,
    Drywall: 25,
    Electricians: 12,
    Exterminators: 16,
    Fence: 23,
    Floors: 22,
    'Garage-Doors': 14,
    Gutters: 37,
    Handyman: 24,
    'Home Security': 39,
    HVAC: 10,
    Insulation: 40,
    'Junk Removal': 33,
    'Kitchen Remodeling': 49,
    Landscaping: 5,
    'Lawn Care': 29,
    'Mold Remediation': 47,
    Painting: 6,
    Plumbing: 15,
    'Power-washing': 34,
    Remodeling: 9,
    'Restoration/Remediation': 26,
    Roofing: 8,
    Siding: 35,
    'Snow Removal': 41,
    'Solar Panels': 42,
    Tile: 19,
    'Tree Services': 28,
    'Wildlife Removal': 46,
    Windows: 32,
  });
});

// ---------------------------------------------------------------------------
// 404 + centralized error handling
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  if (axios.isAxiosError(err)) {
    return res
      .status(502)
      .json({ error: 'Upstream Networx API request failed.' });
  }
  const message =
    NODE_ENV === 'production' ? 'Internal server error' : err.message;
  res.status(500).json({ error: message });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(
      `Networx affiliate server listening on port ${PORT} (${NODE_ENV})`,
    );
  });
}

module.exports = app;
