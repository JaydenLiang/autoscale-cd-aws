#!/usr/bin/env node
'use strict';

const FS = require('fs');
const PATH = require('path');
const COMMANDER = require('commander');
const SHELL = require('shelljs');

const program = new COMMANDER.Command();

const readFileAsJson = filePath => {
    return JSON.parse(FS.readFileSync(filePath, 'utf8'));
};
const saveJsonToFile = (filePath, json) => {
    FS.writeFileSync(filePath, JSON.stringify(json, null, 4));
    console.info(`File is saved: ${filePath}`);
};

const makeTempDir = () => {
    return new Promise((resolve, reject) => {
        SHELL.exec('mktemp -d', { silent: false }, (code, stdout, stderr) => {
            if (code !== 0) {
                reject(stderr);
            } else {
                resolve(stdout.trim());
            }
        });
    });
};

const unpackZip = async filePath => {
    const tempDir = await makeTempDir();
    return new Promise((resolve, reject) => {
        SHELL.exec(
            `unzip -o -d ${tempDir} ${filePath}`,
            { silent: false },
            (code, stdout, stderr) => {
                if (code !== 0) {
                    reject(stderr);
                } else {
                    resolve(tempDir);
                }
            }
        );
    });
};

const genString = (length, specialChars = []) => {
    let ranges = [
        [48, 57],
        [65, 90],
        [97, 122]
    ];
    let charCodes = [],
        size = ranges.length + ((specialChars.length > 0 && 1) || 0);
    for (let i = 0; i < length; i++) {
        let s = Math.floor(Math.random() * size);
        let range = ranges[s];
        if (!range) {
            charCodes.push(
                specialChars[Math.floor(Math.random() * specialChars.length)].charCodeAt(0)
            );
        } else {
            charCodes.push(Math.floor(Math.random() * (range[1] - range[0])) + range[0]);
        }
    }
    return String.fromCharCode(...charCodes);
};

const genPassword = (length, containSymbol = false) => {
    const specialChars =
        (containSymbol && ['!', '@', '#', '$', '%', '^', '&', '*', '+', '-']) || [];
    return genString(length, specialChars);
};

const uploadDeploymentPackageToS3 = (sourceDir, bucket, keyPrefix) => {
    const s3Destination = `s3://${PATH.join(bucket, keyPrefix)}`;
    const command = `aws s3 sync ${sourceDir} ${s3Destination} --no-progress`;
    return new Promise((resolve, reject) => {
        SHELL.exec(command, { silent: false }, (code, stdout, stderr) => {
            if (code !== 0) {
                reject(stderr);
            } else {
                resolve(s3Destination);
            }
        });
    });
};

const loadTemplateFromS3 = (bucket, keyPrefix, templateKey) => {
    return new Promise((resolve, reject) => {
        const filePath = `/tmp/${genString(32)}`;
        const command = `aws s3api get-object --bucket ${bucket} --key "${PATH.join(
            keyPrefix,
            templateKey
        )}" ${filePath}`;
        console.info(`Loading file from S3 using: \n${command}`);
        SHELL.exec(command, { silent: false }, (code, stdout, stderr) => {
            if (code !== 0) {
                reject(stderr);
            } else {
                console.info('File object is loaded.');
                resolve(readFileAsJson(filePath));
            }
        });
    });
};

const paramUseTemplateDefault = param => {
    return param.ParameterValue && param.ParameterValue.trim() === '$[cd_default]';
};

const paramIsOverridden = param => {
    return param.ParameterValue && param.ParameterValue.trim() === '$[cd_overridden]';
};

const getTemplateDefault = (cfnTemplateParams, paramKey) => {
    if (cfnTemplateParams[paramKey] && cfnTemplateParams[paramKey].Default !== undefined) {
        return String(cfnTemplateParams[paramKey].Default);
    } else {
        return '';
    }
};

const fetchAWSAvailabilityZones = () => {
    return new Promise((resolve, reject) => {
        const command = 'aws ec2 describe-availability-zones';
        SHELL.exec(command, { silent: false }, (code, stdout, stderr) => {
            if (code !== 0) {
                reject(stderr);
            } else {
                try {
                    const zoneName = JSON.parse(stdout)
                        .AvailabilityZones.filter(z => z.State === 'available')
                        .map(zone => zone.ZoneName);
                    resolve(zoneName);
                } catch (error) {
                    reject(error);
                }
            }
        });
    });
};

const genAvailabilityZones = async num => {
    let azones = await fetchAWSAvailabilityZones();
    if (azones.length < num) {
        throw new Error(
            'parameter value generation error:' +
                ` not enough availability zones in AWS region: ${process.env.AWS_DEFAULT_REGION}.` +
                ` request: ${num}, got: ${azones.length}`
        );
    }
    azones.sort(() => Math.round(Math.random() * Math.floor(Math.random() * 100)) % 2); // shuffle the array
    return azones.slice(0, num).join(',');
};

const createCloudFormationStack = (
    stackName,
    templateUrl,
    paramFilePath,
    disableRollback = true
) => {
    return new Promise((resolve, reject) => {
        const command =
            `aws cloudformation create-stack --stack-name ${stackName}` +
            ` --template-url "${templateUrl}" --parameters file://${PATH.resolve(paramFilePath)}` +
            `${(!!disableRollback && ' --disable-rollback') || ' --no-disable-rollback'}` +
            ' --capabilities "CAPABILITY_IAM" "CAPABILITY_NAMED_IAM"';
        console.info(`Creating CloudFormation stack using: \n${command}`);
        SHELL.exec(command, { silent: false }, (code, stdout, stderr) => {
            if (code !== 0) {
                reject(stderr.trim());
            } else {
                console.info('Stack creation is completed.');
                console.info(`Stack name: ${stackName}\nRegion: ${process.env.AWS_DEFAULT_REGION}`);
                resolve(stdout.trim());
            }
        });
    });
};

const genOverriddenParam = (key, paramVariableMap) => {
    const value = paramVariableMap.get(key);
    return (value !== undefined && String(value)) || '';
};

const genOverriddenParamMap = inputString => {
    const a = inputString
        .split(' ')
        .map(nvp => {
            const [, name, value] = /Name=(\S+),Value=(\S+)/gi.exec(nvp) || [null, null, null];
            return [name, value];
        })
        .filter(nv => !!nv[0]); // to filter the invalid key value pair
    return new Map(a);
};

const parseParams = (paramJSON, cfnTemplateParams, paramVariableMap) => {
    return Promise.all(
        paramJSON.map(async param => {
            if (paramUseTemplateDefault(param)) {
                param.ParameterValue = getTemplateDefault(cfnTemplateParams, param.ParameterKey);
            } else if (paramIsOverridden(param)) {
                param.ParameterValue = genOverriddenParam(param.ParameterKey, paramVariableMap);
                console.info(
                    `Overridden value: [${param.ParameterValue}], for parameter: ${param.ParameterKey}`
                );
            } else {
                const v = param.ParameterValue.trim();
                let matches;
                if (v.startsWith('$[cd_randchar')) {
                    matches = /^\$\[cd_randchar\S?(\d*)\S*\]/g.exec(v) || [0, 0];
                    if (matches[1]) {
                        param.ParameterValue = genString(Number(matches[1]));
                    }
                } else if (v.startsWith('$[cd_genaz')) {
                    matches = /^\$\[cd_genaz\S?(\d*)\S*\]/g.exec(v) || ['', 0];
                    param.ParameterValue = await genAvailabilityZones(Number(matches[1]));
                } else if (v.startsWith('$[cd_genpass')) {
                    matches = /^\$\[cd_genpass(_strong)?\S?(\d*)\S*\]/g.exec(v) || ['', false, 0];
                    param.ParameterValue = await genPassword(Number(matches[2]), !!matches[1]);
                    console.info(
                        `Generated password: [${param.ParameterValue}], for parameter: ${param.ParameterKey}`
                    );
                }
            }
            return param;
        })
    );
};

const initAWSCLI = command => {
    process.env.AWS_ACCESS_KEY_ID = String(command.accessKeyId).trim();
    process.env.AWS_SECRET_ACCESS_KEY = String(command.secretAccessKey).trim();
    process.env.AWS_DEFAULT_REGION = String(command.awsRegion).trim();
    process.env.AWS_DEFAULT_OUTPUT = 'json';
};

const create = async (bucket, keyPrefix, templatePath, command) => {
    initAWSCLI(command);
    const templateUrl = `https://s3.amazonaws.com/${PATH.join(bucket, keyPrefix, templatePath)}`;
    const paramVariableMap = command.override && genOverriddenParamMap(command.override) || new Map();
    paramVariableMap.set('S3BucketName', bucket);
    paramVariableMap.set('S3KeyPrefix', `${keyPrefix}/`);
    paramVariableMap.set('QSS3BucketName', bucket);
    paramVariableMap.set('QSS3KeyPrefix', `${keyPrefix}/`);
    const paramFilePath = `/tmp/${genString(32)}`;
    try {
        console.info(`Loading template from:\n${templateUrl}`);
        const templateJSON = await loadTemplateFromS3(bucket, keyPrefix, templatePath);
        console.info('Parsing template parameters:');
        let paramJSON = (command.paramFile && readFileAsJson(command.paramFile)) || null;
        paramJSON = await parseParams(paramJSON, templateJSON.Parameters, paramVariableMap, {
            region: command.awsRegion
        });
        await saveJsonToFile(paramFilePath, paramJSON);
        // create stack
        const stackName = `FortiGate-Autoscale-CI-${Date.now()}`;
        await createCloudFormationStack(stackName, templateUrl, paramFilePath);
    } catch (error) {
        console.error(error);
    }
};

const deploy = async (filePath, command) => {
    initAWSCLI(command);
    const sourceDir = await unpackZip(filePath);
    const s3Dest = await uploadDeploymentPackageToS3(sourceDir, command.bucket, command.keyPrefix);
    console.log(`package is extracted to s3 bucket:\n${s3Dest}`);
    console.log('deploy complete.');
    return true;
};

const main = async () => {
    await program.parseAsync(process.argv);
    console.log('program ends.');
};

program
    .description('Autoscale Continuous Deployment Tool.')
    .command('deploy <package-file-path>')
    .description(
        'Deploy a Autoscale deployment package. run deploy -h or --help for command specific help.'
    )
    .requiredOption('-b, --bucket <value>', 'the S3 bucket to upload the deployment package.')
    .requiredOption(
        '-k, --access-key-id <value>',
        'provided access key id for a programatic IAM user access to AWS.'
    )
    .requiredOption(
        '-s, --secret-access-key <value>',
        'provided secret access key for a programatic IAM user access to AWS.'
    )
    .requiredOption('-g, --aws-region <region-code>', 'the region to create stacks.')
    .option(
        '-p, --key-prefix <value>',
        'the sub directory in the specifed S3 bucket to upload the deployment package.'
    )
    .action(deploy);

program
    .command('create <bucket> <key-prefix> <path-to-template>')
    .description(
        'Create a stack for Autoscale using a deployed deployment package. run create -h or --help for command specific help.'
    )
    .requiredOption(
        '-k, --access-key-id <value>',
        'provided access key id for a programatic IAM user access to AWS.'
    )
    .requiredOption(
        '-s, --secret-access-key <value>',
        'provided secret access key for a programatic IAM user access to AWS.'
    )
    .requiredOption('-g, --aws-region <region-code>', 'the region to create stacks.')
    .requiredOption(
        '-K, --ssh-key <value>',
        'the ssh key pairs to login into an ec2 device. must specify one that exists in the specified region.'
    )
    .option(
        '-a, --param-file <file-path>',
        'a json file for all input parameters to deploy the stack. These parameters override all default ones in the specified template.'
    )
    .option(
        '-o, --override <list>',
        'a list of name-value pair to override the template parameter. format: "Name=param-name,Value=new-value[ Name=param-name,Value=new-value[ ...]]"'
    )
    .action(create);

main();
