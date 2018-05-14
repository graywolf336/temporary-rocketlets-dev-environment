const fs = require('fs');
const path = require('path');
const async = require('async');
const figures = require('figures');
const del = require('del');
const through = require('through2');
const gulp = require('gulp');
const file = require('gulp-file');
const gutil = require('gulp-util');
const zip = require('gulp-zip');
const jsonSchema = require('gulp-json-schema');
const sourcemaps = require('gulp-sourcemaps');
const tsc = require('gulp-typescript');
const tslint = require('gulp-tslint');
const refresh = require('gulp-refresh');
const appSchema = require('./app-schema.json');

function getFolders(dir) {
    return fs.readdirSync(dir).filter((file) => fs.statSync(path.join(dir, file)).isDirectory());
}

const appsPath = './apps';
const tsp = tsc.createProject('tsconfig.json');

gulp.task('clean-generated', function _cleanTypescript() {
    return del(['./dist/**']);
});

gulp.task('lint-ts', function _lintTypescript() {
    return tsp.src().pipe(tslint({ formatter: 'verbose' })).pipe(tslint.report());
});

gulp.task('lint-no-exit-ts', function _lintTypescript() {
    return tsp.src().pipe(tslint({ formatter: 'verbose', emitError: false })).pipe(tslint.report());
});

gulp.task('compile-ts', ['clean-generated', 'lint-ts'], function _compileTypescript() {
    return tsp.src().pipe(sourcemaps.init())
            .pipe(tsp())
            .pipe(sourcemaps.write('.'))
            .pipe(gulp.dest('dist'));
});

gulp.task('default', ['clean-generated', 'lint-no-exit-ts','package-for-develop'], function _watchCodeAndRun() {
    refresh.listen();

    gulp.watch(['apps/**/*'],
        ['clean-generated', 'lint-no-exit-ts', 'package-for-develop']);
});

const appsTsCompileOptions = {
    target: 'es5',
    module: 'commonjs',
    moduleResolution: 'node',
    declaration: false,
    noImplicitAny: false,
    removeComments: true,
    strictNullChecks: true,
    noImplicitReturns: true,
    emitDecoratorMetadata: true,
    experimentalDecorators: true,
    lib: [ 'es2017' ]
};

//Packaging related items
function _packageTheApps(callback) {
    const folders = getFolders(appsPath)
                        .filter((folder) => fs.existsSync(path.join(appsPath, folder, 'app.json')) && fs.statSync(path.join(appsPath, folder, 'app.json')).isFile())
                        .map((folder) => {
                            return {
                                folder,
                                dir: path.join(appsPath, folder),
                                toZip: path.join(appsPath, folder, '**'),
                                infoFile: path.join(appsPath, folder, 'app.json'),
                                info: require('./' + path.join(appsPath, folder, 'app.json'))
                            };
                        });

    async.series([
        function _testCompileTheTypeScript(next) {
            const promises = folders.map((item) => {
                return new Promise((resolve) => {
                    if (!fs.existsSync('.tmp')) {
                        fs.mkdirSync('./.tmp');
                    }
                    fs.writeFileSync(`.tmp/${ item.info.id }.json`, JSON.stringify({
                        compilerOptions: appsTsCompileOptions,
                        include: [ __dirname + '/' + item.dir ],
                        exclude: ['node_modules', 'bower_components', 'jspm_packages']
                    }), 'utf8');

                    gutil.log(gutil.colors.yellow(figures.ellipsis), gutil.colors.cyan(`Attempting to compile ${item.info.name} v${item.info.version}`));
                    const project = tsc.createProject(`.tmp/${ item.info.id }.json`);

                    project.src().pipe(project().on('error', () => {
                        item.valid = false;
                    })).pipe(through.obj((file, enc, done) => done(null, file), () => {
                        if (typeof item.valid === 'boolean' && !item.valid) {
                            gutil.log(gutil.colors.red(figures.cross), gutil.colors.cyan(`${item.info.name} v${item.info.version}`), 'has', gutil.colors.red('FAILED to compile.'));
                        } else {
                            gutil.log(gutil.colors.green(figures.tick), gutil.colors.cyan(`${item.info.name} v${item.info.version}`), 'has', gutil.colors.green('successfully compiled.'));
                        }

                        resolve();
                    }));
                });
            });

            Promise.all(promises).then(() => next()).catch((e) => {
                console.error(e);
                throw e;
            });
        },
        function _readTheAppJsonFiles(next) {
            const promises = folders.map((item) => {
                if (typeof item.valid === 'boolean' && !item.valid) return Promise.resolve();

                return new Promise((resolve) => {
                    gulp.src(item.infoFile)
                        .pipe(jsonSchema({ schema: appSchema, emitError: false }))
                        .pipe(through.obj(function transform(file, enc, done) {
                            if (file && !file.isNull() && file.jsonSchemaResult) {
                                item.valid = file.jsonSchemaResult.valid;

                                if (!item.valid) {
                                    gutil.log(gutil.colors.red(figures.cross), gutil.colors.cyan(item.folder + path.sep + 'app.json'), 'has', gutil.colors.red('failed to validate'));
                                }
                            }

                            done(null, file);
                        }, function flush() {
                            resolve();
                        }));
                });
            });

            Promise.all(promises).then(() => next());
        },
        function _onlyZipGoodApps(next) {
            const validItems = folders.filter((item) => item.valid);

            if (validItems.length === 0) {
                next(new Error('No valid Apps.'));
                return;
            }

            const amount = Array.from(Array(10), () => figures.line);
            gutil.log(gutil.colors.white(...amount));
            gutil.log(gutil.colors.white(...amount));
            gutil.log(gutil.colors.red('Errors are listed above'));
            gutil.log(gutil.colors.white(...amount));
            gutil.log(gutil.colors.white(...amount));

            const zippers = validItems.filter((item) => fs.existsSync(path.join(item.dir, item.info.classFile))).map((item) => {
                return new Promise((resolve) => {
                    const zipName = item.info.nameSlug + '_' + item.info.version + '.zip';
                    return gulp.src(item.toZip)
                        .pipe(file('.packagedby', fs.readFileSync('package.json')))
                        .pipe(zip(zipName))
                        .pipe(gulp.dest('dist'))
                        .pipe(through.obj((file, enc, done) => done(null, file), () => {
                            gutil.log(gutil.colors.green(figures.tick),
                                gutil.colors.cyan(item.info.name + ' v' + item.info.version),
                                gutil.colors.blue('has been packaged at:'),
                                gutil.colors.black('dist/' + zipName));
                            resolve();
                        }));
                });
            });

            Promise.all(zippers).then(() => next());
        }
    ], callback);
}

gulp.task('package-for-develop', ['clean-generated', 'lint-no-exit-ts'], _packageTheApps);

gulp.task('package', ['clean-generated', 'lint-ts'], _packageTheApps);
