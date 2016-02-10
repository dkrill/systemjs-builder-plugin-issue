import gulp from 'gulp';
import Builder from 'systemjs-builder';
import System from 'systemjs';

gulp.task('build', () => {
  const builder = new Builder();

  return builder.loadConfig('./config.js')
  .then(() => {
    return builder.buildStatic('./app.js', './out.js')
  .catch(err => {
      process.stderr.write('Build error');
      process.stderr.write(err);
    });
  });
});

gulp.task('default', ['build']);
