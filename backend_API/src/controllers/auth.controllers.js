const UUID = require('uuid').v4
const jwt = require('jsonwebtoken')
const crypto = require('crypto')

const config = require('../utils/config')
const asyncWrapper = require('./../utils/async_wrapper')
const sendEmail = require('./../utils/email')
const { CustomAPIError, BadRequestError, UnauthorizedError } = require('./../utils/custom_errors')
const { getAuthCodes } = require('../utils/auth_codes')
const { decodeJWT } = require('../utils/jwt_handler')

const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(config.GOOGLE_SIGNIN_CLIENT_ID);

const User = require('../models/user.models')
const TestToken = require('../models/test_token.models')
const AuthCode = require('../models/authcode.models')

//Function to sign token - should be moved to utils
const signToken = (id, role, jwtSecret = null, expiry = null) => {
    const expiryDate = expiry ? expiry : process.env.JWT_EXPIRES_IN
    if (!jwtSecret) { jwtSecret = config.JWT_ACCESS_SECRET }
    console.log(jwtSecret)
    return jwt.sign({ id, role }, jwtSecret, {
        expiresIn: expiryDate,
    })
}

//Create token and send to client 
const createToken = (user, statusCode, res) => {
    const token = signToken(user._id, user.role, config.JWT_ACCESS_SECRET, config.JWT_EXPIRES_IN)
    const cookieOptions = {
        expires: new Date(
            Date.now() + process.env.JWT_COOKIE_EXPIRES * 24 * 60 * 60 * 1000,
        ),
        httpOnly: true,
    }
    if (process.env.NODE_ENV === 'production') cookieOptions.secure = true
    res.cookie('jwt', token, cookieOptions)

    // Remove sensitive data from user object
    user.password = undefined
    user.passwordConfirm = undefined
    user.emailVerificationToken = undefined
    user.passwordResetToken = undefined
    user.isVerified = undefined

    res.status(statusCode).json({
        status: 'success',
        token,
        data: {
            user,
        },
    })
}

exports.signup = asyncWrapper(async (req, res, next) => {
    //1. Grab Values from req.body & Store Values in database
    const currentUser = await(await User.create({
        firstname: req.body.firstname,
        lastname: req.body.lastname,
        email: req.body.email,
        role: req.body.role,
        password: req.body.password,
        passwordConfirm: req.body.passwordConfirm,
    })).populate('auth_codes')

    //2. Create email verification Token
    const ver_token = currentUser.createHashedToken('email_verification')
    currentUser.save({ validateBeforeSave: false })

    //3. Save to test token collection -- aids in running unit tests
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
        await TestToken.create({
            user: currentUser._id,
            email_verification: ver_token
        })
    }

    //4. Send email to user
    const url = `${req.protocol}://${req.get(
        'host',
    )}/api/v1/auth/verifyemail/${ver_token}`

    const message = `Please click on the link below to verify your email address: ${url}`
    await sendEmail({
        email: currentUser.email,
        subject: 'Your email verification token link',
        message
    })

    createToken(currentUser, 200, res)

})

exports.login = asyncWrapper(async (req, res, next) => {
    const { email, password } = req.body

    //Check if fields are provided
    if (!email || !password) {
        return next(new CustomAPIError('Please Provide Email and Password', 400))
    }
    //check if email exists
    const currentUser = await User.findOne({ email }).select('+password')
    //Check if email and password matches
    if (
        !currentUser ||
        !(await currentUser.comparePassword(password, currentUser.password))
    ) {
        return next(new CustomAPIError('Incorrect Email or Password', 400))
    }
    //Send token to client
    createToken(currentUser, 200, res)
})

exports.verifyEmail = asyncWrapper(async (req, res, next) => {
    //1. Get email verification token from query params
    const hashedToken = crypto
        .createHash('sha256')
        .update(req.params.token)
        .digest('hex')


    //2. If token is invalid or token has expired
    const user = await User.findOne({ emailVerificationToken: hashedToken }).select('+emailVerificationToken')
    if (!user) {
        return next(
            new CustomAPIError(
                'Token Invalid or Token Expired, Request for a new reset token',
                404,
            ),
        )
    }

    user.isVerified = true
    user.emailVerificationToken = undefined
    await user.save({ validateBeforeSave: false })

    return res.status(201).send({ status: 'success' })
})

exports.forgetPassword = asyncWrapper(async (req, res, next) => {
    const { email } = req.body

    if (!email) {
        throw new BadRequestError('Missing required parameter in request body')
    }

    const current_user = await (await User.findOne({ email })).populate('auth_codes')
    console.log(current_user)
    if (!current_user) { throw new BadRequestError('User does not exist') }

    const { password_reset_code } = await getAuthCodes(current_user._id, 'password_reset')

    sendEmail({
        email: current_user.email,
        subject: "Password reset",
        message: `This is your password reset code ${password_reset_code}`
    })
    const access_token =
        signToken(current_user.id, current_user.role,
            config.JWT_PASSWORDRESET_SECRET, config.JWT_PASSWORDRESET_EXPIRES_IN)
        

    return res.status(200).send({
        message: "Successful, Password reset code sent to users email",
        access_token
    })
})

exports.resetPassword = asyncWrapper(async (req, res, next) => {
    const { new_password, password_reset_code } = req.body

    if (!new_password || !password_reset_code) {
        throw new BadRequestError('Missing required parameter in request body')
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer')) {
        throw new UnauthorizedError('Authentication invalid');
    }

    const jwtToken = authHeader.split(' ')[1];
    const payload = jwt.verify(jwtToken, config.JWT_PASSWORDRESET_SECRET);

    const currUserReset = await AuthCode.findOne({ user: payload.id });
    if (!currUserReset) { throw new UnauthorizedError('Access token expired') }

    const current_user = await (await User.findOne({ _id: payload.id })).populate("auth_codes")
    console.log(current_user)

    if (!current_user) { throw new BadRequestError('User does not exist') }

    if (password_reset_code !== currUserReset.password_reset) {
        throw new BadRequestError('Invalid password reset code')
    }

    await current_user.updateOne({ password: new_password, passwordConfirm: new_password })

    return res.status(200).send({
        message: "Successful, Password reset code sent to users email",
    })
})

exports.googleSignin = asyncWrapper(async (req, res, next) => {
    const authorization = req.headers.authorization;
    const token = authorization.split(' ')[1];

    // Verify id token
    const ticket = await client.verifyIdToken({
        idToken: token,
        audience: config.GOOGLE_SIGNIN_CLIENT_ID,
    }),
        payload = ticket.getPayload(),
        existing_user = await User.findOne({ email: payload.email });

    // Create new user in db
    const random_str = UUID(); // Random unique str as password, won't be needed for authentication
    if (!existing_user) {
        const user_data = {
            firstname: payload.given_name,
            lastname: payload.family_name,
            email: payload.email,
            role: 'EndUser',
            password: random_str,
            passwordConfirm: random_str
        };

        const new_user = await User.create(user_data);
        createToken(new_user, 200, res)
    }

    createToken(existing_user, 200, res)
});

