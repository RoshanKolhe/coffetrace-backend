require('dotenv').config();
const axios = require('axios');
const {Timestamp} = require('firebase-admin').firestore;
const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
const credentials = require('./key.json');
admin.initializeApp({
  credential: admin.credential.cert(credentials),
});
const db = admin.firestore();

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({extended: true}));

// API Endpoint for PhonePe Payment
app.post('/phonepe', async (req, res) => {
  try {
    const {userId, planId} = req.body;

    // Fetch Firestore documents
    const planSnapshot = await db
      .collection('SubscriptionPlans')
      .doc(planId)
      .get();
    const userSnapshot = await db.collection('users').doc(userId).get();

    if (!planSnapshot.exists || !userSnapshot.exists) {
      return res
        .status(404)
        .send('Subscription or User Document does not exist');
    }

    const packDetails = planSnapshot.data();
    const transactionId = `MT${Date.now()}`;
    const data = {
      merchantId: process.env.MERCHANT_ID,
      merchantTransactionId: transactionId,
      merchantUserId: process.env.MERCHANT_USER_ID,
      amount: packDetails.pricing,
      redirectUrl: `${process.env.REACT_APP_URL}/status?user=${userId}|${planId}|${transactionId}`,
      redirectMode: 'REDIRECT',
      callbackUrl: `${process.env.REACT_APP_URL}/status?user=${userId}|${planId}|${transactionId}`,
      mobileNumber: process.env.MERCHANT_MOBILE_NUMBER,
      paymentInstrument: {
        type: 'PAY_PAGE',
      },
    };
    const paymentCollectionInputData = {
      transactionId: transactionId,
      amount: packDetails.pricing,
      date: Timestamp.fromDate(new Date()),
      userRef: db.collection('users').doc(userId),
      isCompleted: false,
    };
    const paymentResp = await db
      .collection('payments')
      .doc(transactionId)
      .set(paymentCollectionInputData);
    if (!paymentResp)
      res.send({status: 400, message: 'payment creation failed'});

    // Encode payment data and generate X-VERIFY header
    const encode = Buffer.from(JSON.stringify(data)).toString('base64');
    const saltKey = process.env.SALT_KEY;
    const saltIndex = process.env.SALT_INDEX;
    const string = encode + '/pg/v1/pay' + saltKey;
    const sha256 = crypto.createHash('sha256').update(string).digest('hex');
    const finalXHeader = `${sha256}###${saltIndex}`;

    // Send POST request to PhonePe API
    const response = await axios.post(
      'https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/pay',
      {
        request: encode,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': finalXHeader,
        },
      },
    );

    const rData = response.data;
    return res.status(200).json(rData);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      status: false,
      error: 'An error occurred while processing the request.',
    });
  }
});

app.post('/checkPaymentStatus', async (req, res) => {
  try {
    const {userId, planId, merchantTransactionId} = req.body;
    const planRef = db.collection('SubscriptionPlans').doc(planId);
    const planSnapshot = await planRef.get();

    if (!planSnapshot.exists) {
      return res.status(404).send('Plan Document does not exist');
    }

    const saltKey = process.env.SALT_KEY;
    const saltIndex = process.env.SALT_INDEX;

    const finalXHeader =
      crypto
        .createHash('sha256')
        .update(
          `/pg/v1/status/${process.env.MERCHANT_ID}/${merchantTransactionId}${saltKey}`,
        )
        .digest('hex') +
      '###' +
      saltIndex;

    const response = await axios.get(
      `https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/status/${process.env.MERCHANT_ID}/${merchantTransactionId}`,
      {
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
          'X-VERIFY': finalXHeader,
          'X-MERCHANT-ID': process.env.MERCHANT_ID,
        },
      },
    );

    const data = response.data;
    if (data.success) {
      const userRef = db.collection('users').doc(userId);
      const paymentRef = db.collection('payments').doc(merchantTransactionId);
      const paymentDate = new Date();

      const validTill = new Date(paymentDate);
      validTill.setMonth(validTill.getMonth() + 1);

      const updateData = {
        planReference: planRef,
        paymentDate: Timestamp.fromDate(paymentDate),
        validTill: Timestamp.fromDate(validTill),
      };
      const paymentInputData = {
        isCompleted: true,
      };
      // Update the document with the new data.
      try {
        await userRef.update(updateData);
        await paymentRef.update(paymentInputData);
        return res.status(200).json(data);
      } catch (error) {
        console.error(error.message);
        return res.status(500).json({
          status: false,
          error: 'Error updating user or payment document',
        });
      }
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      status: false,
      error: 'An error occurred while processing the request.',
    });
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
