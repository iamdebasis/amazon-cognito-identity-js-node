/*!
 * Copyright 2016 Amazon.com,
 * Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Amazon Software License (the "License").
 * You may not use this file except in compliance with the
 * License. A copy of the License is located at
 *
 *     http://aws.amazon.com/asl/
 *
 * or in the "license" file accompanying this file. This file is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, express or implied. See the License
 * for the specific language governing permissions and
 * limitations under the License.
 */
'use strict'
var sjcl = require('sjcl');
var BigInteger = require('jsbn').BigInteger;

var AuthenticationHelper= require('./AuthenticationHelper');
var CognitoAccessToken= require('./CognitoAccessToken');
var CognitoIdToken= require('./CognitoIdToken');
var CognitoRefreshToken= require('./CognitoRefreshToken');
var CognitoUserSession= require('./CognitoUserSession');
var DateHelper = require('./DateHelper');
var CognitoUserAttribute = require('./CognitoUserAttribute');

var LocalStorage = require('node-localstorage').LocalStorage;

/**
 * @callback nodeCallback
 * @template T result
 * @param {*} err The operation failure reason, or null.
 * @param {T} result The operation result.
 */

/**
 * @callback onFailure
 * @param {*} err Failure reason.
 */

/**
 * @callback onSuccess
 * @template T result
 * @param {T} result The operation result.
 */

/**
 * @callback mfaRequired
 * @param {*} details MFA challenge details.
 */

/**
 * @callback customChallenge
 * @param {*} details Custom challenge details.
 */

/**
 * @callback inputVerificationCode
 * @param {*} data Server response.
 */

/**
 * @callback authSuccess
 * @param {CognitoUserSession} session The new session.
 * @param {bool=} userConfirmationNecessary User must be confirmed.
 */


/** @class */
module.exports = class CognitoUser {
  /**
   * Constructs a new CognitoUser object
   * @param {object} data Creation options
   * @param {string} data.Username The user's username.
   * @param {CognitoUserPool} data.Pool Pool containing the user.
   */
  constructor(data) {
    if (data == null || data.Username == null || data.Pool == null) {
      throw new Error('Username and pool information are required.');
    }

    this.username = data.Username || '';
    this.pool = data.Pool;
    this.Session = null;

    this.client = data.Pool.client;

    this.signInUserSession = null;
    this.authenticationFlowType = 'USER_SRP_AUTH';
  }

  /**
   * @returns {CognitoUserSession} the current session for this user
   */
  getSignInUserSession() {
    return this.signInUserSession;
  }

  /**
   * @returns {string} the user's username
   */
  getUsername() {
    return this.username;
  }

  /**
   * @returns {String} the authentication flow type
   */
  getAuthenticationFlowType() {
    return this.authenticationFlowType;
  }

  /**
   * sets authentication flow type
   * @param {string} authenticationFlowType New value.
   * @returns {void}
   */
  setAuthenticationFlowType(authenticationFlowType) {
    this.authenticationFlowType = authenticationFlowType;
  }

  /**
   * This is used for authenticating the user. it calls the AuthenticationHelper for SRP related
   * stuff
   * @param {AuthenticationDetails} authDetails Contains the authentication data
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {newPasswordRequired} callback.newPasswordRequired new
   *        password and any required attributes are required to continue
   * @param {mfaRequired} callback.mfaRequired MFA code
   *        required to continue.
   * @param {customChallenge} callback.customChallenge Custom challenge
   *        response required to continue.
   * @param {authSuccess} callback.onSuccess Called on success with the new session.
   * @returns {void}
   */
  async authenticateUser(authDetails) {
    const authenticationHelper = new AuthenticationHelper(
      this.pool.getUserPoolId().split('_')[1],
      this.pool.getParanoia());
    const dateHelper = new DateHelper();

    let serverBValue;
    let salt;
    const authParameters = {};

    if (this.deviceKey != null) {
      authParameters.DEVICE_KEY = this.deviceKey;
    }

    authParameters.USERNAME = this.username;
    authParameters.SRP_A = authenticationHelper.getLargeAValue().toString(16);

    if (this.authenticationFlowType === 'CUSTOM_AUTH') {
      authParameters.CHALLENGE_NAME = 'SRP_A';
    }

    return new Promise((resolve, reject) => {
      this.client.makeUnauthenticatedRequest('initiateAuth', {
        AuthFlow: this.authenticationFlowType,
        ClientId: this.pool.getClientId(),
        AuthParameters: authParameters,
        ClientMetadata: authDetails.getValidationData(),
      }, (err, data) => {
        if (err) {
          return reject(err);
        }

        const challengeParameters = data.ChallengeParameters;

        this.username = challengeParameters.USER_ID_FOR_SRP;
        serverBValue = new BigInteger(challengeParameters.SRP_B, 16);
        salt = new BigInteger(challengeParameters.SALT, 16);

        const hkdf = authenticationHelper.getPasswordAuthenticationKey(
          this.username,
          authDetails.getPassword(),
          serverBValue,
          salt);
        const secretBlockBits = sjcl.codec.base64.toBits(challengeParameters.SECRET_BLOCK);

        const mac = new sjcl.misc.hmac(hkdf, sjcl.hash.sha256);
        mac.update(sjcl.codec.utf8String.toBits(this.pool.getUserPoolId().split('_')[1]));
        mac.update(sjcl.codec.utf8String.toBits(this.username));
        mac.update(secretBlockBits);
        const dateNow = dateHelper.getNowString();
        mac.update(sjcl.codec.utf8String.toBits(dateNow));
        const signature = mac.digest();
        const signatureString = sjcl.codec.base64.fromBits(signature);

        const challengeResponses = {};

        challengeResponses.USERNAME = this.username;
        challengeResponses.PASSWORD_CLAIM_SECRET_BLOCK = challengeParameters.SECRET_BLOCK;
        challengeResponses.TIMESTAMP = dateNow;
        challengeResponses.PASSWORD_CLAIM_SIGNATURE = signatureString;

        if (this.deviceKey != null) {
          challengeResponses.DEVICE_KEY = this.deviceKey;
        }

        this.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
          ChallengeName: 'PASSWORD_VERIFIER',
          ClientId: this.pool.getClientId(),
          ChallengeResponses: challengeResponses,
          Session: data.Session,
        }, (errAuthenticate, dataAuthenticate) => {
          if (errAuthenticate) {
            return reject(errAuthenticate);
          }

          const challengeName = dataAuthenticate.ChallengeName;
          if (challengeName === 'NEW_PASSWORD_REQUIRED') {
            this.Session = dataAuthenticate.Session;
            let userAttributes = null;
            let rawRequiredAttributes = null;
            const requiredAttributes = [];
            const userAttributesPrefix = authenticationHelper
              .getNewPasswordRequiredChallengeUserAttributePrefix();

            if (dataAuthenticate.ChallengeParameters) {
              userAttributes = JSON.parse(
                dataAuthenticate.ChallengeParameters.userAttributes);
              rawRequiredAttributes = JSON.parse(
                dataAuthenticate.ChallengeParameters.requiredAttributes);
            }

            if (rawRequiredAttributes) {
              for (let i = 0; i < rawRequiredAttributes.length; i++) {
                requiredAttributes[i] = rawRequiredAttributes[i].substr(userAttributesPrefix.length);
              }
            }
            // TODO:
            const error = new Error("new password is required");
            error.data = {"userAttributes": userAttributes, "requiredAttributes": requiredAttributes}
            return reject(error);
          }

          return this.authenticateUserInternal(dataAuthenticate, authenticationHelper).then(value => {
            resolve(value);
          }).catch(err => {
            reject(err);
          });
        });

        return undefined;
      });
    });
  }

  /**
  * PRIVATE ONLY: This is an internal only method and should not
  * be directly called by the consumers.
  * @param {object} dataAuthenticate authentication data
  * @param {object} authenticationHelper helper created
  * @param {callback} callback passed on from caller
  * @returns {void}
  */
  async authenticateUserInternal(dataAuthenticate, authenticationHelper, callback) {
    return new Promise((resolve, reject) => {
      const challengeName = dataAuthenticate.ChallengeName;
      if (challengeName === 'SMS_MFA') {
        this.Session = dataAuthenticate.Session;
        // TODO:
        const error = new Error("MFA is Required");
        error.data = {"challengeName": challengeName}
        return reject(error);
      }

      if (challengeName === 'CUSTOM_CHALLENGE') {
        this.Session = dataAuthenticate.Session;
        // TODO:
        const error = new Error("Custom challenge");
        error.data = {"ChallengeParameters": dataAuthenticate.ChallengeParameters}
        return reject(error);
      }

      if (challengeName === 'DEVICE_SRP_AUTH') {
        // TODO:
        this.getDeviceResponse(callback);
        return undefined;
      }

      this.signInUserSession = this.getCognitoUserSession(dataAuthenticate.AuthenticationResult);
      this.cacheTokens();

      const newDeviceMetadata = dataAuthenticate.AuthenticationResult.NewDeviceMetadata;
      if (newDeviceMetadata == null) {
        return resolve(this.signInUserSession);
      }

      authenticationHelper.generateHashDevice(
        dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceGroupKey,
        dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey);

      const deviceSecretVerifierConfig = {
        Salt: sjcl.codec.base64.fromBits(sjcl.codec.hex.toBits(
                authenticationHelper.getSaltDevices().toString(16))),
        PasswordVerifier: sjcl.codec.base64.fromBits(sjcl.codec.hex.toBits(
                authenticationHelper.getVerifierDevices().toString(16))),
      };

      this.verifierDevices = sjcl.codec.base64.fromBits(
        authenticationHelper.getVerifierDevices());
      this.deviceGroupKey = newDeviceMetadata.DeviceGroupKey;
      this.randomPassword = authenticationHelper.getRandomPassword();

      this.client.makeUnauthenticatedRequest('confirmDevice', {
        DeviceKey: newDeviceMetadata.DeviceKey,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        DeviceSecretVerifierConfig: deviceSecretVerifierConfig,
        DeviceName: 'nodejs-https/amazon-cognito-identity-js-node',
      }, (errConfirm, dataConfirm) => {
        if (errConfirm) {
          return reject(errConfirm);
        }

        this.deviceKey = dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey;
        this.cacheDeviceKeyAndPassword();
        if (dataConfirm.UserConfirmationNecessary === true) {
          return resolve(
            this.signInUserSession, dataConfirm.UserConfirmationNecessary);
        }
        return resolve(this.signInUserSession);
      });
      return undefined;
    });
  }

  /**
  * This method is user to complete the NEW_PASSWORD_REQUIRED challenge.
  * Pass the new password with any new user attributes to be updated.
  * User attribute keys must be of format userAttributes.<attribute_name>.
  * @param {string} newPassword new password for this user
  * @param {object} requiredAttributeData map with values for all required attributes
  * @param {object} callback Result callback map.
  * @param {onFailure} callback.onFailure Called on any error.
  * @param {mfaRequired} callback.mfaRequired MFA code required to continue.
  * @param {customChallenge} callback.customChallenge Custom challenge
  *         response required to continue.
  * @param {authSuccess} callback.onSuccess Called on success with the new session.
  * @returns {void}
  */
  completeNewPasswordChallenge(newPassword, requiredAttributeData, callback) {
    return new Promise((resolve, reject) => {
      if (!newPassword) {
        return reject(new Error('New password is required.'));
      }
      const authenticationHelper = new AuthenticationHelper(
        this.pool.getUserPoolId().split('_')[1], this.pool.getParanoia());
      const userAttributesPrefix = authenticationHelper
        .getNewPasswordRequiredChallengeUserAttributePrefix();

      const finalUserAttributes = {};
      if (requiredAttributeData) {
        Object.keys(requiredAttributeData).forEach((key) => {
          finalUserAttributes[userAttributesPrefix + key] = requiredAttributeData[key];
        });
      }

      finalUserAttributes.NEW_PASSWORD = newPassword;
      finalUserAttributes.USERNAME = this.username;
      this.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ClientId: this.pool.getClientId(),
        ChallengeResponses: finalUserAttributes,
        Session: this.Session,
      }, (errAuthenticate, dataAuthenticate) => {
        if (errAuthenticate) {
          return reject(errAuthenticate);
        }
        return this.authenticateUserInternal(dataAuthenticate, authenticationHelper).then(value => {
          resolve(value);
        }).catch(err => {
          reject(err);
        });
      });

      return undefined;
    });
  }

  /**
   * This is used to get a session using device authentication. It is called at the end of user
   * authentication
   *
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {authSuccess} callback.onSuccess Called on success with the new session.
   * @returns {void}
   * @private
   */
  async getDeviceResponse() {
    const authenticationHelper = new AuthenticationHelper(
      this.deviceGroupKey,
      this.pool.getParanoia());
    const dateHelper = new DateHelper();

    const authParameters = {};

    authParameters.USERNAME = this.username;
    authParameters.DEVICE_KEY = this.deviceKey;
    authParameters.SRP_A = authenticationHelper.getLargeAValue().toString(16);

    return new Promise((resolve, reject) => {
      this.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
        ChallengeName: 'DEVICE_SRP_AUTH',
        ClientId: this.pool.getClientId(),
        ChallengeResponses: authParameters,
      }, (err, data) => {
        if (err) {
          return reject(err);
        }

        const challengeParameters = data.ChallengeParameters;

        const serverBValue = new BigInteger(challengeParameters.SRP_B, 16);
        const salt = new BigInteger(challengeParameters.SALT, 16);

        const hkdf = authenticationHelper.getPasswordAuthenticationKey(
          this.deviceKey,
          this.randomPassword,
          serverBValue,
          salt);
        const secretBlockBits = sjcl.codec.base64.toBits(challengeParameters.SECRET_BLOCK);

        const mac = new sjcl.misc.hmac(hkdf, sjcl.hash.sha256);
        mac.update(sjcl.codec.utf8String.toBits(this.deviceGroupKey));
        mac.update(sjcl.codec.utf8String.toBits(this.deviceKey));
        mac.update(secretBlockBits);
        const dateNow = dateHelper.getNowString();
        mac.update(sjcl.codec.utf8String.toBits(dateNow));
        const signature = mac.digest();
        const signatureString = sjcl.codec.base64.fromBits(signature);

        const challengeResponses = {};

        challengeResponses.USERNAME = this.username;
        challengeResponses.PASSWORD_CLAIM_SECRET_BLOCK = challengeParameters.SECRET_BLOCK;
        challengeResponses.TIMESTAMP = dateNow;
        challengeResponses.PASSWORD_CLAIM_SIGNATURE = signatureString;
        challengeResponses.DEVICE_KEY = this.deviceKey;

        this.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
          ChallengeName: 'DEVICE_PASSWORD_VERIFIER',
          ClientId: this.pool.getClientId(),
          ChallengeResponses: challengeResponses,
          Session: data.Session,
        }, (errAuthenticate, dataAuthenticate) => {
          if (errAuthenticate) {
            return reject(errAuthenticate);
          }

          this.signInUserSession = this.getCognitoUserSession(dataAuthenticate.AuthenticationResult);
          this.cacheTokens();

          return resolve(this.signInUserSession);
        });
        return undefined;
      });
    });
  }

  /**
   * This is used for a certain user to confirm the registration by using a confirmation code
   * @param {string} confirmationCode Code entered by user.
   * @param {bool} forceAliasCreation Allow migrating from an existing email / phone number.
   * @param {nodeCallback<string>} callback Called on success or error.
   * @returns {void}
   */
  confirmRegistration(confirmationCode, forceAliasCreation) {
    return new Promise((resolve, reject) => {
      this.client.makeUnauthenticatedRequest('confirmSignUp', {
        ClientId: this.pool.getClientId(),
        ConfirmationCode: confirmationCode,
        Username: this.username,
        ForceAliasCreation: forceAliasCreation,
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });
    });
  }

  /**
   * This is used by the user once he has the responses to a custom challenge
   * @param {string} answerChallenge The custom challange answer.
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {customChallenge} callback.customChallenge
   *    Custom challenge response required to continue.
   * @param {authSuccess} callback.onSuccess Called on success with the new session.
   * @returns {void}
   */
  async sendCustomChallengeAnswer(answerChallenge) {
    const challengeResponses = {};
    challengeResponses.USERNAME = this.username;
    challengeResponses.ANSWER = answerChallenge;

    return new Promise((resolve, reject) => {
      this.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
        ChallengeName: 'CUSTOM_CHALLENGE',
        ChallengeResponses: challengeResponses,
        ClientId: this.pool.getClientId(),
        Session: this.Session,
      }, (err, data) => {
        if (err) {
          return reject(err);
        }

        const challengeName = data.ChallengeName;

        if (challengeName === 'CUSTOM_CHALLENGE') {
          this.Session = data.Session;
          // TODO:
          const error = new Error("Custom challenge");
          error.data = {"ChallengeParameters": dataAuthenticate.ChallengeParameters}
          return reject(error);
        }

        this.signInUserSession = this.getCognitoUserSession(data.AuthenticationResult);
        this.cacheTokens();
        return resolve(this.signInUserSession);
      });
    });
  }

  /**
   * This is used by the user once he has an MFA code
   * @param {string} confirmationCode The MFA code entered by the user.
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {authSuccess} callback.onSuccess Called on success with the new session.
   * @returns {void}
   */
  async sendMFACode(confirmationCode) {
    const challengeResponses = {};
    challengeResponses.USERNAME = this.username;
    challengeResponses.SMS_MFA_CODE = confirmationCode;

    if (this.deviceKey != null) {
      challengeResponses.DEVICE_KEY = this.deviceKey;
    }

    return new Promise((resolve, reject) => {
      this.client.makeUnauthenticatedRequest('respondToAuthChallenge', {
        ChallengeName: 'SMS_MFA',
        ChallengeResponses: challengeResponses,
        ClientId: this.pool.getClientId(),
        Session: this.Session,
      }, (err, dataAuthenticate) => {
        if (err) {
          return reject(err);
        }

        this.signInUserSession = this.getCognitoUserSession(dataAuthenticate.AuthenticationResult);
        this.cacheTokens();

        if (dataAuthenticate.AuthenticationResult.NewDeviceMetadata == null) {
          return resolve(this.signInUserSession);
        }

        const authenticationHelper = new AuthenticationHelper(
          this.pool.getUserPoolId().split('_')[1],
          this.pool.getParanoia());
        authenticationHelper.generateHashDevice(
          dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceGroupKey,
          dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey);

        const deviceSecretVerifierConfig = {
          Salt: sjcl.codec.base64.fromBits(sjcl.codec.hex.toBits(
            authenticationHelper.getSaltDevices().toString(16))),
          PasswordVerifier: sjcl.codec.base64.fromBits(sjcl.codec.hex.toBits(
            authenticationHelper.getVerifierDevices().toString(16))),
        };

        this.verifierDevices = sjcl.codec.base64.fromBits(
          authenticationHelper.getVerifierDevices());
        this.deviceGroupKey = dataAuthenticate.AuthenticationResult
          .NewDeviceMetadata.DeviceGroupKey;
        this.randomPassword = authenticationHelper.getRandomPassword();

        this.client.makeUnauthenticatedRequest('confirmDevice', {
          DeviceKey: dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey,
          AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
          DeviceSecretVerifierConfig: deviceSecretVerifierConfig,
          DeviceName: 'nodejs-https/amazon-cognito-identity-js-node',
        }, (errConfirm, dataConfirm) => {
          if (errConfirm) {
            return reject(errConfirm);
          }

          this.deviceKey = dataAuthenticate.AuthenticationResult.NewDeviceMetadata.DeviceKey;
          this.cacheDeviceKeyAndPassword();
          if (dataConfirm.UserConfirmationNecessary === true) {
            return resolve(
              this.signInUserSession,
              dataConfirm.UserConfirmationNecessary);
          }
          return resolve(this.signInUserSession);
        });
        return undefined;
      });
    });
  }

  /**
   * This is used by an authenticated user to change the current password
   * @param {string} oldUserPassword The current password.
   * @param {string} newUserPassword The requested new password.
   * @param {nodeCallback<string>} callback Called on success or error.
   * @returns {void}
   */
  async changePassword(oldUserPassword, newUserPassword) {
    return new Promise((resolve, reject) => {
      if (!(this.signInUserSession != null && this.signInUserSession.isValid())) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('changePassword', {
        PreviousPassword: oldUserPassword,
        ProposedPassword: newUserPassword,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });

      return undefined;
    });
  }

  /**
   * This is used by an authenticated user to enable MFA for himself
   * @param {nodeCallback<string>} callback Called on success or error.
   * @returns {void}
   */
  async enableMFA() {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      const mfaOptions = [];
      const mfaEnabled = {
        DeliveryMedium: 'SMS',
        AttributeName: 'phone_number',
      };
      mfaOptions.push(mfaEnabled);

      this.client.makeUnauthenticatedRequest('setUserSettings', {
        MFAOptions: mfaOptions,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });
  
      return undefined;
    });
  }

  /**
   * This is used by an authenticated user to disable MFA for himself
   * @returns {Promise<String>}
   */
  async disableMFA() {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      const mfaOptions = [];

      this.client.makeUnauthenticatedRequest('setUserSettings', {
        MFAOptions: mfaOptions,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, err => {
        if (err) {
          return reject(err);
        }
    
        return resolve('SUCCESS');
      });
      return undefined;
    });
  }


  /**
   * This is used by an authenticated user to delete himself
   * @returns {Promise<String>}
   */
  async deleteUser() {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('deleteUser', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, err => {
        if (err) {
          return reject(err, null);
        }
        return resolve(null, 'SUCCESS');
      });
      return undefined;
    });
  }

  /**
   * @typedef {CognitoUserAttribute | { Name:string, Value:string }} AttributeArg
   */
  /**
   * This is used by an authenticated user to change a list of attributes
   * @param {AttributeArg[]} attributes A list of the new user attributes.
   * @param {nodeCallback<string>} callback Called on success or error.
   * @returns {void}
   */
  async updateAttributes(attributes) {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('updateUserAttributes', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        UserAttributes: attributes,
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });
      return undefined;
    });
  }

  /**
   * This is used by an authenticated user to get a list of attributes
   * @returns {Promise<CognitoUserAttribute[]>}
   */
  async getUserAttributes() {
    return new Promise((resolve, reject) => {
      if (!(this.signInUserSession != null && this.signInUserSession.isValid())) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('getUser', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, (err, userData) => {
        if (err) {
          return reject(err);
        }

        const attributeList = [];

        for (let i = 0; i < userData.UserAttributes.length; i++) {
          const attribute = {
            Name: userData.UserAttributes[i].Name,
            Value: userData.UserAttributes[i].Value,
          };
          const userAttribute = new CognitoUserAttribute(attribute);
          attributeList.push(userAttribute);
        }

        return resolve(attributeList);
      });
      return undefined;
    });
  }

  /**
   * This is used by an authenticated user to delete a list of attributes
   * @param {string[]} attributeList Names of the attributes to delete.
   * @param {nodeCallback<string>} callback Called on success or error.
   * @returns {void}
   */
  async deleteAttributes(attributeList) {
    return new Promise((resolve, reject) => {
      if (!(this.signInUserSession != null && this.signInUserSession.isValid())) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('deleteUserAttributes', {
        UserAttributeNames: attributeList,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });
      return undefined;
    });
  }

  /**
   * This is used by a user to resend a confirmation code
   * @param {nodeCallback<string>} callback Called on success or error.
   * @returns {void}
   */
  async resendConfirmationCode() {
    return new Promise((resolve, reject) => {
      this.client.makeUnauthenticatedRequest('resendConfirmationCode', {
        ClientId: this.pool.getClientId(),
        Username: this.username,
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });
    });
  }

  /**
   * This is used to get a session, either from the session object
   * or from  the local storage, or by using a refresh token
   *
   * @param {nodeCallback<CognitoUserSession>} callback Called on success or error.
   * @returns {void}
   */
  async getSession() {
    return new Promise((resolve, reject) => {
      if (this.username == null) {
        return reject(new Error('Username is null. Cannot retrieve a new session'));
      }

      if (this.signInUserSession != null && this.signInUserSession.isValid()) {
        return resolve(this.signInUserSession);
      }

      const keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}.${this.username}`;
      const idTokenKey = `${keyPrefix}.idToken`;
      const accessTokenKey = `${keyPrefix}.accessToken`;
      const refreshTokenKey = `${keyPrefix}.refreshToken`;

  //    const storage = window.localStorage;
      const storage = new LocalStorage('/tmp/storage');

      if (storage.getItem(idTokenKey)) {
        const idToken = new CognitoIdToken({
          IdToken: storage.getItem(idTokenKey),
        });
        const accessToken = new CognitoAccessToken({
          AccessToken: storage.getItem(accessTokenKey),
        });
        const refreshToken = new CognitoRefreshToken({
          RefreshToken: storage.getItem(refreshTokenKey),
        });

        const sessionData = {
          IdToken: idToken,
          AccessToken: accessToken,
          RefreshToken: refreshToken,
        };
        const cachedSession = new CognitoUserSession(sessionData);
        if (cachedSession.isValid()) {
          this.signInUserSession = cachedSession;
          return resolve(this.signInUserSession);
        }

        if (refreshToken.getToken() == null) {
          return reject(new Error('Cannot retrieve a new session. Please authenticate.'));
        }

        return this.refreshSession(refreshToken).then(value => {
          resolve(value);
        }).catch(err => {
          reject(err);
        });
      }
      return undefined;
    });
  }


  /**
   * This uses the refreshToken to retrieve a new session
   * @param {CognitoRefreshToken} refreshToken A previous session's refresh token.
   * @param {nodeCallback<CognitoUserSession>} callback Called on success or error.
   * @returns {void}
   */
  async refreshSession(refreshToken) {
    const authParameters = {};
    authParameters.REFRESH_TOKEN = refreshToken.getToken();
    const keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}`;
    const lastUserKey = `${keyPrefix}.LastAuthUser`;
//    const storage = window.localStorage;
    const storage = new LocalStorage('/tmp/storage');

    if (storage.getItem(lastUserKey)) {
//  Should set username directly like:
//  cognitoUser.username = 'hoge@hoge.com'
//      this.username = storage.getItem(lastUserKey);
      const deviceKeyKey = `${keyPrefix}.${this.username}.deviceKey`;
      this.deviceKey = storage.getItem(deviceKeyKey);
      authParameters.DEVICE_KEY = this.deviceKey;
    }

    return new Promise((resolve, reject) => {
      this.client.makeUnauthenticatedRequest('initiateAuth', {
        ClientId: this.pool.getClientId(),
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: authParameters,
      }, (err, authResult) => {
        if (err) {
          return reject(err);
        }
        if (authResult) {
          const authenticationResult = authResult.AuthenticationResult;
          if (!Object.prototype.hasOwnProperty.call(authenticationResult, 'RefreshToken')) {
            authenticationResult.RefreshToken = refreshToken.getToken();
          }
          this.signInUserSession = this.getCognitoUserSession(authenticationResult);
          this.cacheTokens();
          return resolve(this.signInUserSession);
        }
        return undefined;
      });
    });
  }

  /**
   * This is used to build a user session from tokens retrieved in the authentication result
   * @param {object} authResult Successful auth response from server.
   * @returns {CognitoUserSession} The new user session.
   * @private
   */
  getCognitoUserSession(authResult) {
    const idToken = new CognitoIdToken(authResult);
    const accessToken = new CognitoAccessToken(authResult);
    const refreshToken = new CognitoRefreshToken(authResult);

    const sessionData = {
      IdToken: idToken,
      AccessToken: accessToken,
      RefreshToken: refreshToken,
    };

    return new CognitoUserSession(sessionData);
  }

  /**
   * This is used to initiate a forgot password request
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {inputVerificationCode?} callback.inputVerificationCode
   *    Optional callback raised instead of onSuccess with response data.
   * @param {onSuccess<void>?} callback.onSuccess Called on success.
   * @returns {void}
   */
  async forgotPassword() {
    return new Promise((resolve, reject) => {
      this.client.makeUnauthenticatedRequest('forgotPassword', {
        ClientId: this.pool.getClientId(),
        Username: this.username,
      }, (err, data) => {
        if (err) {
          return reject(err);
        }

        return resolve(data);
      });
    });
  }

  /**
   * This is used to confirm a new password using a confirmationCode
   * @param {string} confirmationCode Code entered by user.
   * @param {string} newPassword Confirm new password.
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {onSuccess<void>} callback.onSuccess Called on success.
   * @returns {void}
   */
  async confirmPassword(confirmationCode, newPassword) {
    return new Promise((resolve, reject) => {
      this.client.makeUnauthenticatedRequest('confirmForgotPassword', {
        ClientId: this.pool.getClientId(),
        Username: this.username,
        ConfirmationCode: confirmationCode,
        Password: newPassword,
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve();
      });
    });
  }

  /**
   * This is used to initiate an attribute confirmation request
   * @param {string} attributeName User attribute that needs confirmation.
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {inputVerificationCode} callback.inputVerificationCode Called on success.
   * @returns {void}
   */
  async getAttributeVerificationCode(attributeName) {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('getUserAttributeVerificationCode', {
        AttributeName: attributeName,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, (err, data) => {
        if (err) {
          return reject(err);
        }
        return resolve(data);
      });
      return undefined;
    });
  }

  /**
   * This is used to confirm an attribute using a confirmation code
   * @param {string} attributeName Attribute being confirmed.
   * @param {string} confirmationCode Code entered by user.
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {onSuccess<string>} callback.onSuccess Called on success.
   * @returns {void}
   */
  async verifyAttribute(attributeName, confirmationCode) {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('verifyUserAttribute', {
        AttributeName: attributeName,
        Code: confirmationCode,
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });
      return undefined;
    });
  }

  /**
   * This is used to get the device information using the current device key
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {onSuccess<*>} callback.onSuccess Called on success with device data.
   * @returns {void}
   */
  async getDevice() {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return resolve(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('getDevice', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        DeviceKey: this.deviceKey,
      }, (err, data) => {
        if (err) {
          return reject(err);
        }
        return resolve(data);
      });
      return undefined;
    });
  }

  /**
   * This is used to forget the current device
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {onSuccess<string>} callback.onSuccess Called on success.
   * @returns {void}
   */
  async forgetDevice() {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('forgetDevice', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        DeviceKey: this.deviceKey,
      }, err => {
        if (err) {
          return reject(err);
        }
        this.deviceKey = null;
        this.deviceGroupkey = null;
        this.randomPassword = null;
        return resolve('SUCCESS');
      });
      return undefined;
    });
  }

  /**
   * This is used to set the device status as remembered
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {onSuccess<string>} callback.onSuccess Called on success.
   * @returns {void}
   */
  async setDeviceStatusRemembered() {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('updateDeviceStatus', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        DeviceKey: this.deviceKey,
        DeviceRememberedStatus: 'remembered',
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });
      return undefined;
    });
  }

  /**
   * This is used to set the device status as not remembered
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {onSuccess<string>} callback.onSuccess Called on success.
   * @returns {void}
   */
  async setDeviceStatusNotRemembered() {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('updateDeviceStatus', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        DeviceKey: this.deviceKey,
        DeviceRememberedStatus: 'not_remembered',
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });
      return undefined;
    });
  }

  /**
   * This is used to list all devices for a user
   *
   * @param {int} limit the number of devices returned in a call
   * @param {string} paginationToken the pagination token in case any was returned before
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {onSuccess<*>} callback.onSuccess Called on success with device list.
   * @returns {void}
   */
  async listDevices(limit, paginationToken) {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('listDevices', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
        Limit: limit,
        PaginationToken: paginationToken,
      }, (err, data) => {
        if (err) {
          return reject(err);
        }
        return resolve(data);
      });
      return undefined;
    });
  }

  /**
   * This is used to globally revoke all tokens issued to a user
   * @param {object} callback Result callback map.
   * @param {onFailure} callback.onFailure Called on any error.
   * @param {onSuccess<string>} callback.onSuccess Called on success.
   * @returns {void}
   */
  async globalSignOut() {
    return new Promise((resolve, reject) => {
      if (this.signInUserSession == null || !this.signInUserSession.isValid()) {
        return reject(new Error('User is not authenticated'));
      }

      this.client.makeUnauthenticatedRequest('globalSignOut', {
        AccessToken: this.signInUserSession.getAccessToken().getJwtToken(),
      }, err => {
        if (err) {
          return reject(err);
        }
        return resolve('SUCCESS');
      });
      return undefined;
    });
  }

  /**
   * This is used to save the session tokens to local storage
   * @returns {void}
   */
  cacheTokens() {
    const keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}`;
    const idTokenKey = `${keyPrefix}.${this.username}.idToken`;
    const accessTokenKey = `${keyPrefix}.${this.username}.accessToken`;
    const refreshTokenKey = `${keyPrefix}.${this.username}.refreshToken`;
    const lastUserKey = `${keyPrefix}.LastAuthUser`;

//    const storage = window.localStorage;
    const storage = new LocalStorage('/tmp/storage');

    storage.setItem(idTokenKey, this.signInUserSession.getIdToken().getJwtToken());
    storage.setItem(accessTokenKey, this.signInUserSession.getAccessToken().getJwtToken());
    storage.setItem(refreshTokenKey, this.signInUserSession.getRefreshToken().getToken());
    storage.setItem(lastUserKey, this.username);
  }

  /**
   * This is used to cache the device key and device group and device password
   * @returns {void}
   */
  cacheDeviceKeyAndPassword() {
    const keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}.${this.username}`;
    const deviceKeyKey = `${keyPrefix}.deviceKey`;
    const randomPasswordKey = `${keyPrefix}.randomPasswordKey`;
    const deviceGroupKeyKey = `${keyPrefix}.deviceGroupKey`;

//    const storage = window.localStorage;
    const storage = new LocalStorage('/tmp/storage');

    storage.setItem(deviceKeyKey, this.deviceKey);
    storage.setItem(randomPasswordKey, this.randomPassword);
    storage.setItem(deviceGroupKeyKey, this.deviceGroupKey);
  }

  /**
   * This is used to get current device key and device group and device password
   * @returns {void}
   */
  getCachedDeviceKeyAndPassword() {
    const keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}.${this.username}`;
    const deviceKeyKey = `${keyPrefix}.deviceKey`;
    const randomPasswordKey = `${keyPrefix}.randomPasswordKey`;
    const deviceGroupKeyKey = `${keyPrefix}.deviceGroupKey`;

//    const storage = window.localStorage;
    const storage = new LocalStorage('/tmp/storage');

    if (storage.getItem(deviceKeyKey)) {
      this.deviceKey = storage.getItem(deviceKeyKey);
      this.randomPassword = storage.getItem(randomPasswordKey);
      this.deviceGroupKey = storage.getItem(deviceGroupKeyKey);
    }
  }

  /**
   * This is used to clear the device key info from local storage
   * @returns {void}
   */
  clearCachedDeviceKeyAndPassword() {
    const keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}.${this.username}`;
    const deviceKeyKey = `${keyPrefix}.deviceKey`;
    const randomPasswordKey = `${keyPrefix}.randomPasswordKey`;
    const deviceGroupKeyKey = `${keyPrefix}.deviceGroupKey`;

//    const storage = window.localStorage;
    const storage = new LocalStorage('/tmp/storage');

    storage.removeItem(deviceKeyKey);
    storage.removeItem(randomPasswordKey);
    storage.removeItem(deviceGroupKeyKey);
  }

  /**
   * This is used to clear the session tokens from local storage
   * @returns {void}
   */
  clearCachedTokens() {
    const keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}`;
    const idTokenKey = `${keyPrefix}.${this.username}.idToken`;
    const accessTokenKey = `${keyPrefix}.${this.username}.accessToken`;
    const refreshTokenKey = `${keyPrefix}.${this.username}.refreshToken`;
    const lastUserKey = `${keyPrefix}.LastAuthUser`;

//    const storage = window.localStorage;
    const storage = new LocalStorage('/tmp/storage');

    storage.removeItem(idTokenKey);
    storage.removeItem(accessTokenKey);
    storage.removeItem(refreshTokenKey);
    storage.removeItem(lastUserKey);
  }

  /**
   * This is used for the user to signOut of the application and clear the cached tokens.
   * @returns {void}
   */
  signOut() {
    this.signInUserSession = null;
    self.clearCachedTokens();
  }
}
