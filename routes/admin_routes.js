/* eslint-disable no-await-in-loop */
// Load Environment Variables
require('dotenv').config();

const express = require('express');
const { body } = require('express-validator');
const mailer = require('nodemailer');
const path = require('path');
const Email = require('email-templates');
const parser = require('../dist/markdown/parser');
const { ensureRole, csrfProtection, flashValidationErrors } = require('./middleware');

const User = require('../dynamo/models/user');
const Notice = require('../dynamo/models/notice');
const Comment = require('../models/comment');
const Content = require('../dynamo/models/content');
const FeaturedCubes = require('../models/featuredCubes');
const Cube = require('../dynamo/models/cube');
const { render } = require('../serverjs/render');
const util = require('../serverjs/util');
const fq = require('../serverjs/featuredQueue');
const notice = require('../dynamo/models/notice');

const ensureAdmin = ensureRole('Admin');

const router = express.Router();

router.use(csrfProtection);

router.get('/dashboard', ensureAdmin, async (req, res) => {
  const noticeCount = await Notice.getByStatus(Notice.STATUS.ACTIVE);
  const contentInReview = await Content.getByStatus(Content.STATUS.IN_REVIEW);

  return render(req, res, 'AdminDashboardPage', {
    noticeCount: noticeCount.items.length,
    contentInReview: contentInReview.items.length,
  });
});

const PAGE_SIZE = 24;

router.get('/comments', async (req, res) => {
  return res.redirect('/admin/notices');
});

router.get('/comments/:page', ensureAdmin, async (req, res) => {
  const count = await Comment.countDocuments();
  const comments = await Comment.find()
    .sort({ timePosted: -1 })
    .skip(Math.max(req.params.page, 0) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();

  return render(req, res, 'AdminCommentsPage', { comments, count, page: Math.max(req.params.page, 0) });
});

router.get('/reviewcontent', ensureAdmin, async (req, res) => {
  const content = await Content.getByStatus(Content.STATUS.IN_REVIEW);
  return render(req, res, 'ReviewContentPage', { content: content.items });
});

router.get('/notices', ensureAdmin, async (req, res) => {
  const notices = await Notice.getByStatus(Notice.STATUS.ACTIVE);
  return render(req, res, 'NoticePage', { notices: notices.items });
});

router.get('/publish/:id', ensureAdmin, async (req, res) => {
  const document = await Content.getById(req.params.id);

  if (document.Status !== Content.STATUS.IN_REVIEW) {
    req.flash('danger', `Content not in review`);
    return res.redirect('/admin/reviewcontent');
  }

  document.Status = Content.STATUS.PUBLISHED;
  document.Date = new Date().valueOf();

  const owner = await User.getById(document.Owner);

  await Content.update(document);

  if (owner) {
    await util.addNotification(
      owner,
      req.user,
      `/content/${document.Type}/${document.Id}`,
      `${req.user.username} has approved and published your content: ${document.Title}`,
    );

    const mentions = parser.findUserLinks(document.Body).map((x) => x.toLowerCase());
    for (const username of mentions) {
      const query = await User.getByUsername(username);

      if (query.items.length === 1) {
        await util.addNotification(
          query.items[0],
          owner,
          `/content/${document.Type}/${document.Id}`,
          `${owner.username} mentioned you in their content`,
        );
      }
    }
  }

  const smtpTransport = mailer.createTransport({
    name: 'CubeCobra.com',
    secure: true,
    service: 'Gmail',
    auth: {
      user: process.env.EMAIL_CONFIG_USERNAME,
      pass: process.env.EMAIL_CONFIG_PASSWORD,
    },
  });

  const email = new Email({
    message: {
      from: 'Cube Cobra Team <support@cubecobra.com>',
      to: owner.email,
      subject: 'Your content has been published',
    },
    send: true,
    juiceResources: {
      webResources: {
        relativeTo: path.join(__dirname, '..', 'public'),
        images: true,
      },
    },
    transport: smtpTransport,
  });

  email.send({
    template: 'content_publish',
    locals: {
      title: document.Title,
      url: `https://cubecobra.com/content/${document.Type}/${document.Id}`,
    },
  });

  req.flash('success', `Content published: ${document.Title}`);

  return res.redirect('/admin/reviewcontent');
});

router.get('/removereview/:id', ensureAdmin, async (req, res) => {
  const document = await Content.getById(req.params.id);

  if (document.Status !== Content.STATUS.IN_REVIEW) {
    req.flash('danger', `Content not in review`);
    return res.redirect('/admin/reviewcontent');
  }

  document.Status = Content.STATUS.DRAFT;
  document.Date = new Date().valueOf();

  const owner = await User.getById(document.Owner);

  await Content.update(document);

  if (owner) {
    await util.addNotification(
      owner,
      req.user,
      `/content/${document.Type}/${document.Id}`,
      `${req.user.username} has declined to publish your content: ${document.Title}`,
    );
  }

  const smtpTransport = mailer.createTransport({
    name: 'CubeCobra.com',
    secure: true,
    service: 'Gmail',
    auth: {
      user: process.env.EMAIL_CONFIG_USERNAME,
      pass: process.env.EMAIL_CONFIG_PASSWORD,
    },
  });

  const email = new Email({
    message: {
      from: 'Cube Cobra Team <support@cubecobra.com>',
      to: owner.Email,
      subject: 'Your Content was not published',
    },
    send: true,
    juiceResources: {
      webResources: {
        relativeTo: path.join(__dirname, '..', 'public'),
        images: true,
      },
    },
    transport: smtpTransport,
  });

  await email.send({
    template: 'content_decline',
    locals: {
      title: document.Title,
      url: `https://cubecobra.com/content/${document.Type}/${document.Id}`,
    },
  });

  req.flash('success', `Content declined: ${document.Title}`);

  return res.redirect('/admin/reviewcontent');
});

router.get('/ignorereport/:id', ensureAdmin, async (req, res) => {
  const report = await Notice.getById(req.params.id);

  report.Status = Notice.STATUS.PROCESSED;
  await Notice.update(report);

  req.flash('success', 'This report has been ignored.');
  return res.redirect('/admin/notices');
});

router.get('/removecomment/:id', ensureAdmin, async (req, res) => {
  const report = await Notice.getById(req.params.id);
  const comment = await Comment.findById(report.Subject);

  comment.owner = null;
  comment.ownerName = null;
  comment.image =
    'https://c1.scryfall.com/file/scryfall-cards/art_crop/front/0/c/0c082aa8-bf7f-47f2-baf8-43ad253fd7d7.jpg?1562826021';
  comment.artist = 'Allan Pollack';
  comment.updated = true;
  comment.content = '[removed by moderator]';
  // the -1000 is to prevent weird time display error
  comment.timePosted = Date.now() - 1000;

  await comment.save();

  req.flash('success', 'This comment has been deleted.');
  return res.redirect('/admin/notices');
});

router.get('/application/approve/:id', ensureAdmin, async (req, res) => {
  const application = await Notice.getById(req.params.id);

  const user = await User.getById(application.User);
  if (!user.Roles) {
    user.Roles = [];
  }
  if (!user.Roles.includes(User.ROLES.CONTENT_CREATOR)) {
    user.Roles.push(User.ROLES.CONTENT_CREATOR);
  }
  await User.update(user);

  application.Status = Notice.STATUS.PROCESSED;
  Notice.update(application);

  const smtpTransport = mailer.createTransport({
    name: 'CubeCobra.com',
    secure: true,
    service: 'Gmail',
    auth: {
      user: process.env.EMAIL_CONFIG_USERNAME,
      pass: process.env.EMAIL_CONFIG_PASSWORD,
    },
  });

  const email = new Email({
    message: {
      from: 'Cube Cobra Team <support@cubecobra.com>',
      to: user.Email,
      subject: 'Cube Cobra Content Creator',
    },
    send: true,
    juiceResources: {
      webResources: {
        relativeTo: path.join(__dirname, '..', 'public'),
        images: true,
      },
    },
    transport: smtpTransport,
  });

  await email.send({
    template: 'application_approve',
    locals: {},
  });

  req.flash('success', `Application for ${user.Username} approved.`);
  return res.redirect(`/admin/notices`);
});

router.get('/application/decline/:id', ensureAdmin, async (req, res) => {
  const application = await Notice.getById(req.params.id);

  notice.Status = Notice.STATUS.PROCESSED;
  Notice.update(notice);

  const user = await User.getById(application.userid);

  const smtpTransport = mailer.createTransport({
    name: 'CubeCobra.com',
    secure: true,
    service: 'Gmail',
    auth: {
      user: process.env.EMAIL_CONFIG_USERNAME,
      pass: process.env.EMAIL_CONFIG_PASSWORD,
    },
  });

  const email = new Email({
    message: {
      from: 'Cube Cobra Team <support@cubecobra.com>',
      to: user.email,
      subject: 'Cube Cobra Content Creator',
    },
    send: true,
    juiceResources: {
      webResources: {
        relativeTo: path.join(__dirname, '..', 'public'),
        images: true,
      },
    },
    transport: smtpTransport,
  });

  await email.send({
    template: 'application_decline',
    locals: {},
  });

  req.flash('danger', `Application declined.`);
  return res.redirect(`/admin/notices`);
});

router.get('/featuredcubes', ensureAdmin, async (req, res) => {
  const featured = await FeaturedCubes.getSingleton();
  const ids = featured.queue.map((f) => f.cubeID);
  const cubes = await Cube.batchGet(ids.map((id) => `${id}`));

  return render(req, res, 'FeaturedCubesQueuePage', {
    cubes,
    daysBetweenRotations: featured.daysBetweenRotations,
    lastRotation: featured.lastRotation,
  });
});

router.post('/featuredcubes/rotate', ensureAdmin, async (req, res) => {
  const rotate = await fq.rotateFeatured();
  for (const message of rotate.messages) {
    req.flash('danger', message);
  }

  if (rotate.success === 'false') {
    req.flash('danger', 'Featured Cube rotation failed!');
    return res.redirect('/admin/featuredcubes');
  }

  const olds = await User.batchGet(rotate.removed.map((f) => f.ownerID));
  const news = await User.batchGet(rotate.added.map((f) => f.ownerID));
  const notifications = [];
  for (const old of olds) {
    notifications.push(
      util.addNotification(old, req.user, '/user/account?nav=patreon', 'Your cube is no longer featured.'),
    );
  }
  for (const newO of news) {
    notifications.push(
      util.addNotification(newO, req.user, '/user/account?nav=patreon', 'Your cube has been featured!'),
    );
  }
  await Promise.all(notifications);
  return res.redirect('/admin/featuredcubes');
});

router.post(
  '/featuredcubes/setperiod/:days',
  ensureAdmin,
  util.wrapAsyncApi(async (req, res) => {
    const days = Number.parseInt(req.params.days, 10);
    if (!Number.isInteger(days)) {
      return res.status(400).send({
        success: 'false',
        message: 'Days between rotations must be an integer',
      });
    }

    await fq.updateFeatured(async (featured) => {
      featured.daysBetweenRotations = days;
    });
    return res.send({ success: 'true', period: days });
  }),
);

router.post('/featuredcubes/queue', ensureAdmin, async (req, res) => {
  if (!req.body.cubeId) {
    req.flash('danger', 'Cube ID not sent');
    return res.redirect('/admin/featuredcubes');
  }
  const cube = await Cube.getById(req.body.cubeId);
  if (!cube) {
    req.flash('danger', 'Cube does not exist');
    return res.redirect('/admin/featuredcubes');
  }

  if (cube.isPrivate) {
    req.flash('danger', 'Cannot feature private cube');
    return res.redirect('/admin/featuredcubes');
  }

  const update = await fq.updateFeatured(async (featured) => {
    const index = featured.queue.findIndex((c) => c.cubeID.equals(cube._id));
    if (index !== -1) {
      throw new Error('Cube is already in queue');
    }
    featured.queue.push({ cubeID: cube._id, ownerID: cube.owner });
  });

  if (!update.ok) {
    req.flash('danger', update.message);
    return res.redirect('/admin/featuredcubes');
  }

  const user = await User.getById(`${cube.owner}`);
  await util.addNotification(
    user,
    req.user,
    '/user/account?nav=patreon',
    'An admin added your cube to the featured cubes queue.',
  );
  return res.redirect('/admin/featuredcubes');
});

router.post('/featuredcubes/unqueue', ensureAdmin, async (req, res) => {
  if (!req.body.cubeId) {
    req.flash('Cube ID not sent');
    return res.redirect('/admin/featuredcubes');
  }

  const update = await fq.updateFeatured(async (featured) => {
    const index = featured.queue.findIndex((c) => c.cubeID.equals(req.body.cubeId));
    if (index === -1) {
      throw new Error('Cube not found in queue');
    }
    if (index < 2) {
      throw new Error('Cannot remove currently featured cube from queue');
    }
    return featured.queue.splice(index, 1);
  });
  if (!update.ok) {
    req.flash('danger', update.message);
    return res.redirect('/admin/featuredcubes');
  }

  const [removed] = update.return;
  const user = await User.getById(removed.ownerID);
  await util.addNotification(
    user,
    req.user,
    '/user/account?nav=patreon',
    'An admin removed your cube from the featured cubes queue.',
  );
  return res.redirect('/admin/featuredcubes');
});

router.post(
  '/featuredcubes/move',
  ensureAdmin,
  body('cubeId', 'Cube ID must be sent').not().isEmpty(),
  body('from', 'Cannot move currently featured cube').isInt({ gt: 2 }).toInt(),
  body('to', 'Cannot move cube to featured position').isInt({ gt: 2 }).toInt(),
  flashValidationErrors,
  async (req, res) => {
    if (!req.validated) return res.redirect('/admin/featuredcubes');
    let { from, to } = req.body;
    // indices are sent in human-readable form (indexing from 1)
    from -= 1;
    to -= 1;

    const update = await fq.updateFeatured(async (featured) => {
      if (featured.queue.length <= from || !featured.queue[from].cubeID.equals(req.body.cubeId))
        throw new Error('Cube is not at expected position in queue');
      if (featured.queue.length <= to) throw new Error('Target position is higher than cube length');
      const [spliced] = featured.queue.splice(from, 1);
      featured.queue.splice(to, 0, spliced);
    });

    if (!update.ok) req.flash('danger', update.message);
    else req.flash('success', 'Successfully moved cube');

    return res.redirect('/admin/featuredcubes');
  },
);

module.exports = router;
